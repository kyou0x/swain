// as: packages/cli/src/sub/swain-bin.ts
import { runSwain } from "./swain.js";

runSwain({ argv: process.argv.slice(2), env: process.env.SWAIN_DB }); // expect: P-PROCESS
