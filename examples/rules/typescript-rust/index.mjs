import { nativePlugin } from "lintrs/native";

export default nativePlugin({
  name: "example",
  rules: ["call-returns-union"],
  crate: new URL("./", import.meta.url),
});
