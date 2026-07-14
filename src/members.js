import { readFile } from "node:fs/promises";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim())) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim())) {
    rows.push(row);
  }

  return rows;
}

function compactProfile(record) {
  return [
    record.name,
    record.group ? `群組=${record.group}` : "",
    record.gender ? `性別=${record.gender}` : "",
    record.partner ? `伴侶=${record.partner}` : "",
    record.logic ? `底層=${record.logic}` : "",
    record.note ? `備註=${record.note}` : ""
  ]
    .filter(Boolean)
    .join("；");
}

export async function loadMemberRoster(filePath) {
  if (!filePath) {
    return { byId: new Map(), describeUser: () => "" };
  }

  try {
    const text = await readFile(filePath, "utf8");
    const [header, ...rows] = parseCsv(text.replace(/^\uFEFF/, ""));
    const indexes = new Map(header.map((name, index) => [name.trim(), index]));
    const byId = new Map();

    for (const row of rows) {
      const id = row[indexes.get("ID")]?.trim();

      if (!id) {
        continue;
      }

      byId.set(id, {
        group: row[indexes.get("所屬群組")]?.trim() ?? "",
        id,
        name: row[indexes.get("名稱")]?.trim() ?? "",
        gender: row[indexes.get("性別")]?.trim() ?? "",
        partner: row[indexes.get("伴侶")]?.trim() ?? "",
        logic: row[indexes.get("底層邏輯")]?.trim() ?? "",
        note: row[indexes.get("備註")]?.trim() ?? ""
      });
    }

    console.log(`[members] loaded ${byId.size} roster entr${byId.size === 1 ? "y" : "ies"}`);

    return {
      byId,
      describeUser(user) {
        const record = byId.get(user.id);
        return record ? compactProfile(record) : "";
      }
    };
  } catch (error) {
    console.warn(`[members] failed to load roster: ${error.message}`);
    return { byId: new Map(), describeUser: () => "" };
  }
}

