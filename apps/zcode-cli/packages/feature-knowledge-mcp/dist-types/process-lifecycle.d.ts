export declare function installMcpProcessGuards(input: {
    onOutputClosed: (error: Error) => void;
    process: Pick<NodeJS.Process, "on">;
    writeStderr: (text: string) => void;
}): void;
export declare function installMcpShutdownTriggers(input: {
    process: Pick<NodeJS.Process, "once">;
    shutdown: () => void;
    stdin: Pick<NodeJS.ReadStream, "once">;
}): void;
export declare function isDirectMcpEntrypoint(importMetaUrl: string, argvPath: string | undefined): Promise<boolean>;
//# sourceMappingURL=process-lifecycle.d.ts.map