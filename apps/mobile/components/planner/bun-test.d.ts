// Minimal ambient types for `bun:test` so `tsc --noEmit` type-checks the pure
// unit tests (bun-types isn't a dependency). Functions only, so this merges
// cleanly with any other declaration of the module.
declare module "bun:test" {
    interface BunMatchers {
        toBe(expected: unknown): void;
        toEqual(expected: unknown): void;
        toStrictEqual(expected: unknown): void;
        toBeNull(): void;
        toBeUndefined(): void;
        toBeDefined(): void;
        toBeTruthy(): void;
        toBeFalsy(): void;
        toBeGreaterThan(n: number): void;
        toBeGreaterThanOrEqual(n: number): void;
        toBeLessThan(n: number): void;
        toBeLessThanOrEqual(n: number): void;
        toContain(item: unknown): void;
        toHaveLength(n: number): void;
        toThrow(expected?: unknown): void;
        not: BunMatchers;
    }
    export function describe(name: string, fn: () => void): void;
    export function test(name: string, fn: () => void | Promise<void>): void;
    export function expect(actual: unknown): BunMatchers;
}
