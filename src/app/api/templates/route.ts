import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { newId } from "@/lib/ids";

export const runtime = "nodejs";

type TemplateRow = { id: string; name: string; created_at: string; song_count: string };
type SongMeta = { id: string; display_name: string; sort_order: number };

export async function GET() {
  const templates = await sql<TemplateRow>(
    `select t.id, t.name, t.created_at,
            (select count(*)::text from songs s where s.template_id = t.id) as song_count
     from templates t
     order by t.created_at desc`,
  );

  const withSongs = await Promise.all(
    templates.map(async (t) => {
      const songs = await sql<SongMeta>(
        `select id, display_name, sort_order from songs
         where template_id = $1 order by sort_order asc, created_at asc`,
        [t.id],
      );
      return {
        id: t.id,
        name: t.name,
        createdAt: t.created_at,
        songCount: Number(t.song_count),
        songs: songs.map((s) => ({
          id: s.id,
          displayName: s.display_name,
          sortOrder: s.sort_order,
        })),
      };
    }),
  );

  return NextResponse.json({ templates: withSongs });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "Template name is required" }, { status: 400 });
  }

  const songNames = form.getAll("songNames").map((v) => String(v).trim());
  const files = form.getAll("songFiles");

  if (songNames.length === 0 || files.length === 0) {
    return NextResponse.json({ error: "Add at least one song" }, { status: 400 });
  }
  if (songNames.length !== files.length) {
    return NextResponse.json({ error: "Each song needs a name and MP3" }, { status: 400 });
  }

  const templateId = newId();
  await sql(`insert into templates (id, name) values ($1, $2)`, [templateId, name]);

  for (let i = 0; i < songNames.length; i++) {
    const displayName = songNames[i];
    const file = files[i];
    if (!displayName) {
      return NextResponse.json({ error: "Song name required" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Invalid audio file" }, { status: 400 });
    }
    if (file.size > 12 * 1024 * 1024) {
      return NextResponse.json({ error: "Each MP3 must be under 12MB" }, { status: 400 });
    }
    const mime = file.type || "audio/mpeg";
    if (!mime.includes("audio") && !file.name.toLowerCase().endsWith(".mp3")) {
      return NextResponse.json({ error: "Only audio/MP3 files are allowed" }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    await sql(
      `insert into songs (id, template_id, display_name, mime_type, audio_data, sort_order)
       values ($1, $2, $3, $4, $5, $6)`,
      [newId(), templateId, displayName, mime, buf, i],
    );
  }

  return NextResponse.json({ id: templateId, name });
}
