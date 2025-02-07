import dotenv from "dotenv"

import { TextDecoder, TextEncoder } from "util"
import { readFile, unlink, writeFile } from "node:fs/promises"
import { ensureDir, existsSync, remove } from "fs-extra"
import { resolve, dirname } from "node:path"
import { glob } from "glob"
import { debug, error, info, isQuiet, warn } from "./log"
import { execa } from "execa"
import { join } from "node:path"
import { createNodePath } from "./nodepath"
import { DockerManager } from "./docker"
import { createFileSystem } from "../../core/src/filesystem"
import { filterGitIgnore } from "../../core/src/gitignore"
import {
    parseDefaultsFromEnv,
    parseTokenFromEnv,
} from "../../core/src/connection"
import {
    DEFAULT_MODEL,
    DEFAULT_TEMPERATURE,
    MODEL_PROVIDER_AZURE,
    SHELL_EXEC_TIMEOUT,
    DOT_ENV_FILENAME,
    MODEL_PROVIDER_OLLAMA,
    TOOL_ID,
    DEFAULT_EMBEDDINGS_MODEL,
} from "../../core/src/constants"
import { tryReadText } from "../../core/src/fs"
import {
    ServerManager,
    ModelService,
    LanguageModelConfiguration,
    LogLevel,
    UTF8Decoder,
    UTF8Encoder,
    RuntimeHost,
    setRuntimeHost,
    ResponseStatus,
} from "../../core/src/host"
import { AbortSignalOptions, TraceOptions } from "../../core/src/trace"
import { logVerbose, unique } from "../../core/src/util"
import { parseModelIdentifier } from "../../core/src/models"
import { AuthenticationToken, createAzureToken } from "./azuretoken"
import { LanguageModel } from "../../core/src/chat"
import { errorMessage } from "../../core/src/error"

class NodeServerManager implements ServerManager {
    async start(): Promise<void> {
        throw new Error("not implement")
    }
    async close(): Promise<void> {
        throw new Error("not implement")
    }
}

class ModelManager implements ModelService {
    private pulled: string[] = []

    constructor(private readonly host: RuntimeHost) {}
    private async getModelToken(modelId: string) {
        const { provider } = parseModelIdentifier(modelId)
        const conn = await this.host.getLanguageModelConfiguration(modelId)
        if (provider === MODEL_PROVIDER_OLLAMA)
            conn.base = conn.base.replace(/\/v1$/i, "")
        return conn
    }

    async pullModel(modelid: string): Promise<ResponseStatus> {
        const { provider, model } = parseModelIdentifier(modelid)
        if (provider === MODEL_PROVIDER_OLLAMA) {
            if (this.pulled.includes(modelid)) return { ok: true }

            if (!isQuiet) logVerbose(`ollama pull ${model}`)
            const conn = await this.getModelToken(modelid)
            const res = await fetch(`${conn.base}/api/pull`, {
                method: "POST",
                headers: {
                    "user-agent": TOOL_ID,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ name: model, stream: false }, null, 2),
            })
            if (res.ok) {
                const resp = await res.json()
            }
            if (res.ok) this.pulled.push(modelid)
            return { ok: res.ok, status: res.status }
        }

        return { ok: true }
    }
}

export class NodeHost implements RuntimeHost {
    readonly dotEnvPath: string
    userState: any = {}
    models: ModelService
    readonly path = createNodePath()
    readonly server = new NodeServerManager()
    readonly workspace = createFileSystem()
    readonly docker = new DockerManager()
    readonly defaultModelOptions = {
        model: DEFAULT_MODEL,
        temperature: DEFAULT_TEMPERATURE,
    }
    readonly defaultEmbeddingsModelOptions = {
        embeddingsModel: DEFAULT_EMBEDDINGS_MODEL,
    }

    constructor(dotEnvPath: string) {
        this.dotEnvPath = dotEnvPath
        this.syncDotEnv()
        this.models = new ModelManager(this)
    }

    private syncDotEnv() {
        if (existsSync(this.dotEnvPath)) {
            const res = dotenv.config({
                path: this.dotEnvPath,
                debug: !!process.env.DEBUG,
                override: true,
            })
            if (res.error) throw res.error
        }
    }

    static async install(dotEnvPath: string) {
        dotEnvPath = dotEnvPath || resolve(DOT_ENV_FILENAME)
        const h = new NodeHost(dotEnvPath)
        setRuntimeHost(h)
        await h.parseDefaults()
        return h
    }

    async readSecret(name: string): Promise<string | undefined> {
        this.syncDotEnv()
        return process.env[name]
    }

    private async parseDefaults() {
        this.syncDotEnv()
        await parseDefaultsFromEnv(process.env)
    }
    clientLanguageModel: LanguageModel

    private _azureToken: AuthenticationToken
    async getLanguageModelConfiguration(
        modelId: string,
        options?: { token?: boolean } & AbortSignalOptions & TraceOptions
    ): Promise<LanguageModelConfiguration> {
        const { signal, token: askToken } = options || {}
        await this.parseDefaults()
        const tok = await parseTokenFromEnv(process.env, modelId)
        if (!askToken && tok?.token) tok.token = "***"
        if (
            askToken &&
            tok &&
            !tok.token &&
            tok.provider === MODEL_PROVIDER_AZURE
        ) {
            if (
                !this._azureToken ||
                this._azureToken.expiresOnTimestamp >= Date.now()
            )
                this._azureToken = await createAzureToken(signal)
            if (!this._azureToken) throw new Error("Azure token not available")
            tok.token = "Bearer " + this._azureToken.token
        }
        if (!tok && this.clientLanguageModel) {
            return <LanguageModelConfiguration>{
                model: modelId,
                provider: this.clientLanguageModel.id,
                source: "client",
            }
        }

        return tok
    }

    log(level: LogLevel, msg: string): void {
        if (msg === undefined) return
        switch (level) {
            case LogLevel.Error:
                error(msg)
                break
            case LogLevel.Warn:
                warn(msg)
                break
            case LogLevel.Verbose:
                debug(msg)
                break
            case LogLevel.Info:
            default:
                info(msg)
                break
        }
    }
    createUTF8Decoder(): UTF8Decoder {
        return new TextDecoder("utf-8")
    }
    createUTF8Encoder(): UTF8Encoder {
        return new TextEncoder()
    }
    projectFolder(): string {
        return this.path.resolve(".")
    }
    installFolder(): string {
        return this.projectFolder()
    }
    resolvePath(...segments: string[]) {
        return this.path.resolve(...segments)
    }
    async readFile(name: string): Promise<Uint8Array> {
        const wksrx = /^workspace:\/\//i
        if (wksrx.test(name))
            name = join(this.projectFolder(), name.replace(wksrx, ""))

        // read file
        const res = await readFile(name)
        return res ? new Uint8Array(res) : new Uint8Array()
    }
    async findFiles(
        path: string | string[],
        options: {
            ignore?: string | string[]
            applyGitIgnore?: boolean
        }
    ): Promise<string[]> {
        const { ignore, applyGitIgnore } = options || {}
        let files = await glob(path, {
            nodir: true,
            windowsPathsNoEscape: true,
            ignore,
        })
        if (applyGitIgnore) {
            const gitignore = await tryReadText(".gitignore")
            files = await filterGitIgnore(gitignore, files)
        }
        return unique(files)
    }
    async writeFile(name: string, content: Uint8Array): Promise<void> {
        await ensureDir(dirname(name))
        await writeFile(name, content)
    }
    async deleteFile(name: string) {
        await unlink(name)
    }
    async createDirectory(name: string): Promise<void> {
        await ensureDir(name)
    }
    async deleteDirectory(name: string): Promise<void> {
        await remove(name)
    }

    async exec(
        containerId: string,
        command: string,
        args: string[],
        options: ShellOptions & TraceOptions
    ) {
        if (containerId) {
            const container = await this.docker.container(containerId)
            return await container.exec(command, args, options)
        }

        const {
            trace,
            label,
            cwd,
            timeout = SHELL_EXEC_TIMEOUT,
            stdin: input,
        } = options || {}
        try {
            trace?.startDetails(label || command)

            // python3 on windows -> python
            if (command === "python3" && process.platform === "win32")
                command = "python"
            if (command === "python" && process.platform !== "win32")
                command = "python3"

            trace?.itemValue(`cwd`, cwd)
            trace?.item(`\`${command}\` ${args.join(" ")}`)

            const { stdout, stderr, exitCode, failed } = await execa(
                command,
                args,
                {
                    cleanup: true,
                    input,
                    timeout,
                    cwd,
                    preferLocal: true,
                    stripFinalNewline: true,
                    stdin: input ? undefined : "ignore",
                    stdout: ["pipe"],
                    stderr: ["pipe"],
                }
            )
            trace?.itemValue(`exit code`, `${exitCode}`)
            if (stdout) trace?.detailsFenced(`📩 stdout`, stdout)
            if (stderr) trace?.detailsFenced(`📩 stderr`, stderr)
            return { stdout, stderr, exitCode, failed }
        } catch (err) {
            trace?.error("exec failed", err)
            return {
                stdout: "",
                stderr: errorMessage(err),
                exitCode: 1,
                failed: true,
            }
        } finally {
            trace?.endDetails()
        }
    }

    /**
     * Starts a container to execute sandboxed code
     * @param options
     */
    async container(
        options: ContainerOptions & TraceOptions
    ): Promise<ContainerHost> {
        return await this.docker.startContainer(options)
    }

    async removeContainers(): Promise<void> {
        await this.docker.stopAndRemove()
    }
}
