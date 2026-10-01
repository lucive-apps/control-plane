import { describe, expect, it } from "vite-plus/test";

import { DeviceMessageDecoder, encodeRequest, parseAgentKeyEvent } from "./CreatorMicroProtocol.ts";

const report = (channel: number, text: string) => {
  const bytes = Buffer.alloc(64);
  bytes[0] = 0x06;
  bytes[1] = channel;
  bytes[2] = Buffer.byteLength(text);
  bytes.write(text, 3, "utf8");
  return new Uint8Array(bytes);
};

describe("encodeRequest", () => {
  it("splits a long request into 64-byte reports of at most 61 payload bytes", () => {
    const request = {
      method: "fs.write",
      params: { file: "keymap.json", data: "x".repeat(150) },
      id: 7,
    };
    const reports = encodeRequest(request);
    expect(reports.length).toBeGreaterThan(1);
    let text = "";
    for (const bytes of reports) {
      expect(bytes).toHaveLength(64);
      expect(bytes[0]).toBe(0x06);
      expect(bytes[1]).toBe(2);
      expect(bytes[2]).toBeLessThanOrEqual(61);
      text += Buffer.from(bytes.slice(3, 3 + bytes[2]!)).toString("utf8");
    }
    expect(JSON.parse(text)).toEqual(request);
  });
});

describe("DeviceMessageDecoder", () => {
  it("reassembles a response split across reports, with braces inside strings", () => {
    const decoder = new DeviceMessageDecoder();
    const message = JSON.stringify({
      result: { data: '{"a":"}{"}' + "y".repeat(80) },
      id: 12,
      method: "fs.read",
    });
    const parts = [message.slice(0, 61), message.slice(61, 122), message.slice(122)];
    expect(decoder.push(report(2, parts[0]!))).toEqual([]);
    expect(decoder.push(report(2, parts[1]!))).toEqual([]);
    const [decoded] = decoder.push(report(2, parts[2]!));
    expect(decoded).toMatchObject({ kind: "response", id: 12, method: "fs.read" });
  });

  it("reads the short notification envelope and ignores the debug channel", () => {
    const decoder = new DeviceMessageDecoder();
    expect(decoder.push(report(1, "boot log {"))).toEqual([]);
    expect(decoder.push(report(2, '{"m":"v.oai.hid","p":{"k":"AG03","act":1}}'))).toEqual([
      { kind: "notification", method: "v.oai.hid", params: { k: "AG03", act: 1 } },
    ]);
  });

  it("accepts reports without the leading report id byte", () => {
    const decoder = new DeviceMessageDecoder();
    const withId = report(2, '{"result":{"ok":1},"id":3,"method":"v.oai.thstatus"}');
    expect(decoder.push(withId.subarray(1))).toMatchObject([{ kind: "response", id: 3 }]);
  });

  it("skips a malformed message and keeps decoding", () => {
    const decoder = new DeviceMessageDecoder();
    expect(decoder.push(report(2, '{"result":nope}{"result":1,"id":4}'))).toMatchObject([
      { kind: "response", id: 4, result: 1 },
    ]);
  });
});

describe("parseAgentKeyEvent", () => {
  it("decodes agent key presses and releases", () => {
    expect(parseAgentKeyEvent("v.oai.hid", { k: "AG05", act: 1, ag: 0 })).toEqual({
      keyIndex: 5,
      pressed: true,
    });
    expect(parseAgentKeyEvent("v.oai.hid", { k: "AG00", act: 0 })).toEqual({
      keyIndex: 0,
      pressed: false,
    });
  });

  it("ignores other notifications and keys", () => {
    expect(parseAgentKeyEvent("v.oai.rad", { a: 0.2, d: 1 })).toBeNull();
    expect(parseAgentKeyEvent("v.oai.hid", { k: "ENC_CW", act: 2 })).toBeNull();
    expect(parseAgentKeyEvent("v.oai.hid", { k: "AG01", act: 2 })).toBeNull();
  });
});
