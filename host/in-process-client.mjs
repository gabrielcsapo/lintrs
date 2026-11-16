import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = new URL(import.meta.url).searchParams.get("sdk");
if (source === null)
  throw new Error("The in-process client requires the pinned SDK path");
const { combineTimingInfo, disabledTimingInfo, TimingCollector } = await import(
  pathToFileURL(join(source, "api/timing.ts")).href
);
const bindingPath = process.env.RLINT_IN_PROCESS_BINDING;
if (bindingPath === undefined || !isAbsolute(bindingPath))
  throw new Error("RLINT_IN_PROCESS_BINDING must name an absolute .node file");
const binding = createRequire(import.meta.url)(bindingPath);
if (typeof binding.createSession !== "function")
  throw new Error("The native binding does not export createSession");

// This preserves the pinned SDK's client contract while replacing its child-process transport.
export class Client {
  constructor(options) {
    if (options.fs !== undefined || "pipe" in options)
      throw new Error(
        "The in-process bridge supports native filesystem sessions only",
      );
    if (
      options.useCaseSensitiveFileNames !== undefined ||
      options.runExternalCode
    )
      throw new Error(
        "Case-sensitivity overrides and external content mappers are unsupported by the in-process bridge",
      );
    this.session =
      process.env.RLINT_SHARED_SESSION === undefined
        ? binding.createSession(resolve(options.cwd ?? process.cwd()))
        : binding.attachSession(process.env.RLINT_SHARED_SESSION);
    this.nativeMethods =
      process.env.RLINT_TYPED_NATIVE === "1"
        ? new Set(this.session.typedMethods())
        : undefined;
    this.timing = options.collectTiming ? new TimingCollector() : undefined;
    this.nativeStats = options.collectTiming ? {} : undefined;
    this.maxResponseBytesPerPage = options.maxResponseBytesPerPage;
  }

  request(method, params) {
    const payload = JSON.stringify(params) ?? "";
    const start = performance.now();
    const result = this.session.request(method, payload);
    this.timing?.record({
      method,
      roundTripMs: performance.now() - start,
      bytesSent: Buffer.byteLength(payload),
      bytesReceived:
        typeof result === "string" ? Buffer.byteLength(result) : result.length,
    });
    return result;
  }

  apiRequest(method, params) {
    if (this.nativeMethods?.has(method))
      return this.direct(method, () =>
        this.session.requestValue(method, params),
      );
    const result = this.request(method, params);
    if (typeof result !== "string")
      throw new Error(`Unexpected binary response for ${method}`);
    return result.length > 0 ? JSON.parse(result) : undefined;
  }

  direct(method, action) {
    const start = performance.now();
    const result = action();
    if (this.nativeStats !== undefined)
      this.nativeStats[method] = (this.nativeStats[method] ?? 0) + 1;
    this.timing?.record({
      method,
      roundTripMs: performance.now() - start,
      bytesSent: 0,
      bytesReceived: 0,
    });
    return result;
  }

  nodeFacts(snapshot, project, file, indices, mask, fields = []) {
    if (fields.length > 0)
      return this.direct("rlintNodeFactsPlanned", () =>
        this.session.nodeFactsPlanned(
          snapshot,
          project,
          file,
          indices,
          mask,
          fields,
        ),
      );
    return this.direct("rlintNodeFacts", () =>
      this.session.nodeFacts(snapshot, project, file, indices, mask),
    );
  }

  objectProperty(snapshot, project, kind, handle, property) {
    return this.direct(`rlintProperty:${kind}:${property}`, () =>
      this.session.objectProperty(snapshot, project, kind, handle, property),
    );
  }

  apiRequestBinary(method, params) {
    const result = this.request(method, params);
    if (!Buffer.isBuffer(result))
      throw new Error(`Unexpected JSON response for ${method}`);
    return result.length > 0 ? result : undefined;
  }

  batchRequests(requests) {
    const params = { requests };
    if (this.maxResponseBytesPerPage !== undefined)
      params.maxResponseBytesPerPage = this.maxResponseBytesPerPage;
    const first = this.apiRequest("batchRequests", params);
    let responses = first.responses;
    let continuationToken = first.continuationToken;
    while (continuationToken) {
      const pageParams = { requests: [], continuationToken };
      if (this.maxResponseBytesPerPage !== undefined)
        pageParams.maxResponseBytesPerPage = this.maxResponseBytesPerPage;
      const page = this.apiRequest("batchRequests", pageParams);
      responses = responses.concat(page.responses);
      continuationToken = page.continuationToken;
    }
    return { responses };
  }

  registerCallback() {
    throw new Error(
      "JavaScript callbacks are unsupported by the in-process bridge",
    );
  }

  echo() {
    throw new Error("Transport echo is unavailable for in-process sessions");
  }

  echoBinary() {
    throw new Error("Transport echo is unavailable for in-process sessions");
  }

  getTimingInfo() {
    if (this.timing === undefined) return disabledTimingInfo();
    return combineTimingInfo(
      this.timing.getInfo(),
      JSON.parse(this.session.timing()),
    );
  }

  resetTimingInfo() {
    this.timing?.reset();
    this.session.resetTiming();
  }

  getTimingCollector() {
    return this.timing;
  }

  close() {
    this.session.close();
  }
}
