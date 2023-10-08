import * as v from "@badrap/valita";

export const CachedStatus = v.union(
    v.object({
        kind: v.literal(`found`),
        current: v.string(),
        outOfDate: v.boolean(),
        minorOutOfDate: v.boolean(),
        hasTypes: v.boolean(),
    }),
    v.object({
        kind: v.literal(`not-in-registry`),
    }),
    v.object({
        kind: v.literal(`non-npm`),
    }),
    v.object({
        kind: v.literal(`error`),
        message: v.string(),
    }),
);
export type CachedStatus = v.Infer<typeof CachedStatus>;

export const CachedInfo = v.object({
    dashboardVersion: v.literal(1),
    fullNpmName: v.string(),
    subDirectoryPath: v.string(),
    typesVersion: v.string(),
    unescapedName: v.string(),
    status: CachedStatus,
});
export type CachedInfo = v.Infer<typeof CachedInfo>;

export const PackageJSON = v.object({
    version: v.string(),
    types: v.unknown().optional(),
    typings: v.unknown().optional(),
    exports: v.unknown().optional(),
});
export type PackageJSON = v.Infer<typeof PackageJSON>;

export class FatalError extends Error {}

export const JSDelivrMetadata = v.object({
    files: v.array(v.object({
        name: v.string(),
    })),
});
export type JSDelivrMetadata = v.Infer<typeof JSDelivrMetadata>;
