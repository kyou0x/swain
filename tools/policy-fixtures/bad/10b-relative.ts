// as: packages/core/src/sub/x.ts
import "../../test/x.js"; // expect: P-RELATIVE
import "../../../cli/src/main.js"; // expect: P-RELATIVE
import "../y.js";
