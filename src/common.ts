import * as v from "@badrap/valita";

export const CachedStatus = v.union(
    v.object({
        kind: v.literal(`found`),
        latest: v.string(),
        outOfDate: v.boolean(),
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
    typesName: v.string(),
    typesVersion: v.string(),
    realName: v.string(),
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
