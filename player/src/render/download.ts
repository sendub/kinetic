// A file download from the page itself (docs/plan.md Phase 21, "Export
// progress"): a Blob URL on a temporary `<a download>`, clicked. Works
// over `file://` as over http, needs no server, and the browser saves it
// to its downloads folder under `name`.

export function downloadText(doc: Document, name: string, text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = doc.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  // Revoked after the click's navigation has picked the URL up.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
