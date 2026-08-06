/** Small persistence helpers built on DSH's reviewed atomic replacement primitive. */
/** Error thrown when durable JSON is malformed or has an unexpected root shape. */
export declare class DurableDataError extends Error {
    readonly path: string;
    constructor(message: string, path: string, options?: ErrorOptions);
}
/** Atomically replace a user-private UTF-8 text file. */
export declare function atomicWriteText(path: string, content: string): Promise<void>;
/** Atomically replace a user-private JSON file with stable human-readable output. */
export declare function atomicWriteJson(path: string, value: unknown): Promise<void>;
/** Read JSON and fail with a path-bearing diagnostic. */
export declare function readJson(path: string): Promise<unknown>;
/** Read an object-rooted JSON document. */
export declare function readJsonObject(path: string): Promise<Record<string, unknown>>;
/** Serialize a read-modify-write update across processes. */
export declare function updateJsonObject<T>(path: string, update: (current: Record<string, unknown> | undefined) => T | Promise<T>): Promise<T>;
//# sourceMappingURL=atomic.d.ts.map