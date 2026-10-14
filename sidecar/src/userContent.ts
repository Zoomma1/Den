import type { ImageAttachment } from "../../src/types/protocol";

export type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageAttachment["mediaType"]; data: string } };

// Sans image on garde la chaîne brute : le comportement historique reste identique.
export function buildUserContent(msg: { text: string; images?: ImageAttachment[] }): string | UserContentBlock[] {
  if (!msg.images || msg.images.length === 0) return msg.text;
  const blocks: UserContentBlock[] = msg.images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  if (msg.text !== "") blocks.push({ type: "text", text: msg.text });
  return blocks;
}
