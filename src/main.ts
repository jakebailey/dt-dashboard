import { Command, Option, runExit } from "clipanion";
import { glob } from "glob";

void runExit(
    class MainCommand extends Command {
        dtCheckout = Option.String({ required: true });

        async execute() {
            this.context.stdout.write(`DefinitelyTyped checkout at ${this.dtCheckout}!\n`);

            const p = await getTopLevelPackages(this.dtCheckout);
            this.context.stdout.write(`Found ${p.length} packages!\n`);

            // TODO: use DT infra instead of glob
        }
    },
);

function getTopLevelPackages(dtCheckout: string) {
    return glob(`types/*`, { cwd: dtCheckout, absolute: true });
}
