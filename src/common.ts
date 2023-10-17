import path from "node:path";

import * as v from "@badrap/valita";

export const CachedStatus = v.union(
    v.object({
        kind: v.literal(`found`),
        current: v.string(),
        outOfDate: v.union(v.literal(`major`), v.literal(`minor`)).optional(),
        hasTypes: v.boolean(),
    }),
    v.object({
        kind: v.literal(`not-in-registry`),
    }),
    v.object({
        kind: v.literal(`unpublished`),
    }),
    v.object({
        kind: v.literal(`missing-version`),
        latest: v.string(),
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
    dashboardVersion: v.literal(4),
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

export const MetadataFile = v.object({
    type: v.literal(`file`),
    name: v.string(),
});
export type MetadataFile = v.Infer<typeof MetadataFile>;

type MetadataDirectory = {
    type: `directory`;
    name: string;
    files?: (MetadataFile | MetadataDirectory)[] | undefined;
};
export const MetadataDirectory: v.Type<MetadataDirectory> = v.object({
    type: v.literal(`directory`),
    name: v.string(),
    files: v.array(v.union(MetadataFile, v.lazy(() => MetadataDirectory))).optional(),
});

export const Metadata = v.object({
    files: v.array(v.union(MetadataFile, MetadataDirectory)).optional(),
});
export type Metadata = v.Infer<typeof Metadata>;

export function findInMetadata(metadata: Metadata, fn: (filename: string) => boolean): boolean {
    if (metadata.files) {
        for (const filename of iterate(`/`, metadata.files)) {
            const result = fn(filename);
            if (result) {
                return true;
            }
        }
    }
    return false;

    // eslint-disable-next-line unicorn/consistent-function-scoping
    function* iterate(parent: string, files: (MetadataFile | MetadataDirectory)[]): Generator<string> {
        for (const file of files) {
            if (file.type === `file`) {
                yield path.posix.resolve(parent, file.name);
            } else if (file.files) {
                yield* iterate(path.posix.resolve(parent, file.name), file.files);
            }
        }
    }
}
