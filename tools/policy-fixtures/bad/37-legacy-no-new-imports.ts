// as: packages/cli/src/x.ts
// cli may import server, db and client (N1.8 widening); model, otlp and sdk-ts stay barred.
import { d } from "@swain/model"; // expect: P-IMPORT
import { e } from "@swain/otlp"; // expect: P-IMPORT
import { f } from "@swain/sdk-ts"; // expect: P-IMPORT
export { d, e, f };
