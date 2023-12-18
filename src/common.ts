import path from "node:path";

import * as v from "@badrap/valita";

export const CachedStatus = v.union(
    v.object({
        kind: v.literal(`found`),
        current: v.string(),
        outOfDate: v.union(v.literal(`major`), v.literal(`minor`), v.literal(`too-new`)).optional(),
        hasTypes: v.union(v.literal(`package.json`), v.literal(`entrypoint`), v.literal(`other`)).optional(),
        packageJsonTypeMatches: v.boolean(),
    }),
    v.object({
        kind: v.literal(`not-in-registry`),
    }),
    v.object({
        kind: v.literal(`unpublished`),
    }),
    v.object({
        kind: v.literal(`missing-version`),
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

export const dashboardVersion = 8 as const;

export const CachedInfo = v.object({
    dashboardVersion: v.literal(dashboardVersion),
    fullNpmName: v.string(),
    subDirectoryPath: v.string(),
    typesVersion: v.string(),
    unescapedName: v.string(),
    status: CachedStatus,
});
export type CachedInfo = v.Infer<typeof CachedInfo>;

export const NpmManifest = v.object({
    version: v.string(),
    main: v.unknown().optional(),
    types: v.unknown().optional(),
    typings: v.unknown().optional(),
    exports: v.unknown().optional(),
    type: v.string().optional(),
});
export type NpmManifest = v.Infer<typeof NpmManifest>;

export const DTPackageJson = v.object({
    name: v.string().optional(),
    version: v.string().optional(),
    nonNpm: v.boolean().optional(),
    type: v.string().optional(),
});
export type DTPackageJson = v.Infer<typeof DTPackageJson>;

export class FatalError extends Error {}

const MetadataFile = v.object({
    type: v.literal(`file`),
    name: v.string().optional(),
    path: v.string().optional(),
});
type MetadataFile = v.Infer<typeof MetadataFile>;

type MetadataDirectory = {
    type: `directory`;
    name?: string | undefined;
    path?: string | undefined;
    files?: (MetadataFile | MetadataDirectory)[] | undefined;
};
const MetadataDirectory: v.Type<MetadataDirectory> = v.object({
    type: v.literal(`directory`),
    name: v.string().optional(),
    path: v.string().optional(),
    files: v.array(v.union(MetadataFile, v.lazy(() => MetadataDirectory))).optional(),
});

export const Metadata = v.object({
    files: v.array(v.union(MetadataFile, MetadataDirectory)).optional(),
});
export type Metadata = v.Infer<typeof Metadata>;

export function forEachFileInMetadata(metadata: Metadata, fn: (filename: string) => void): void {
    if (metadata.files) {
        for (const filename of iterate(`/`, metadata.files)) {
            fn(filename);
        }
    }

    // eslint-disable-next-line unicorn/consistent-function-scoping
    function* iterate(parent: string, files: (MetadataFile | MetadataDirectory)[]): Generator<string> {
        for (const file of files) {
            const absPath = file.path ?? (file.name === undefined ? undefined : path.resolve(parent, file.name));
            if (!absPath) throw new Error(`File has no name or path: ${JSON.stringify(file)}`);

            if (file.type === `file`) {
                yield absPath;
            } else if (file.files) {
                yield* iterate(absPath, file.files);
            }
        }
    }
}
