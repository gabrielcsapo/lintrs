// Fixture plugin used by host/native.test.mjs. Exercises every fixture rule.
import { nativePlugin } from "../../host/native/index.mjs";

export default nativePlugin({
  name: "demo",
  rules: [
    "value-is-string",
    "rename-value",
    "suggest-rename",
    "no-non-ascii-string",
  ],
  crate: new URL("./demo-rules", import.meta.url),
});
