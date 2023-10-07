import { Command, Option, runExit } from "clipanion";

void runExit(
    class MainCommand extends Command {
        name = Option.String();

        async execute() {
            this.context.stdout.write(`Hello ${this.name}!\n`);
        }
    },
);
