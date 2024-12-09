/* eslint-disable @stylistic/quotes */

module.exports = {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    target: (dependencyName, [{ semver, version, operator, major, minor, patch, release, build }]) => {
        if (major === "0") return "minor";
        return "latest";
    },
};
