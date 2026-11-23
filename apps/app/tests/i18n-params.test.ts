import { describe, expect, test } from "bun:test";

import { t } from "../src/i18n";

describe("t() params", () => {
  test("fills every copy of a repeated placeholder", () => {
    const en = t("work.start.host_note", { name: "Zendesk", lng: "en" });
    expect(en).not.toContain("{name}");
    expect(en.match(/Zendesk/g)?.length).toBe(2);

    const zh = t("work.start.host_note", { name: "Zendesk", lng: "zh" });
    expect(zh).not.toContain("{name}");
    expect(zh.match(/Zendesk/g)?.length).toBe(2);
  });

  test("keeps dollar signs in values literal", () => {
    expect(t("work.start.host_note", { name: "$& $1", lng: "en" })).toContain("open $& $1 at");
  });
});
