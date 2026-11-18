import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";

/**
 * Study packs: Markdown files in ~/.jarvis/study/ that turn Jarvis into a tutor or examiner, for
 * example an oral-exam drill for a course. They stay on this PC, outside the repository, because
 * they hold personal course material. "Jarvis, start ING400-øving" loads one.
 */
export interface StudyPack {
  name: string;
  title: string;
  text: string;
}

/** Lowercase letters and digits only, so "ING 400", "ing-400" and "ING400" all match. */
const compact = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export class StudyPacks {
  constructor(private readonly dir: string) {}

  list(): { name: string; title: string }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => {
        const name = basename(f, ".md");
        return { name, title: titleOf(readFileSync(join(this.dir, f), "utf8")) || name };
      });
  }

  /** The pack whose file name or title matches the query. With one pack and no query, that pack. */
  find(query = ""): StudyPack | null {
    const packs = this.list();
    const q = compact(query);
    const hit = q
      ? packs.find((p) => compact(p.name) === q) ??
        packs.find((p) => q.includes(compact(p.name)) || compact(p.name).includes(q)) ??
        packs.find((p) => compact(p.title).includes(q))
      : packs.length === 1
        ? packs[0]
        : undefined;
    if (!hit) return null;
    return { ...hit, text: readFileSync(join(this.dir, `${hit.name}.md`), "utf8") };
  }
}

function titleOf(md: string): string {
  return md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
}

/** System text for an active study session: voice rules first, then the pack itself. */
export function studyInstructions(pack: StudyPack): string {
  return `ØVINGSMODUS: ${pack.title}

Reglene her gjelder foran de vanlige reglene om korte svar, så lenge øvingen varer.
- Dette er muntlig øving over tale. Alt du sier leses opp, og han svarer muntlig. Bruk aldri markdown, tabeller, punktlister, kodeblokker eller overskrifter. Når materialet ber om en meny, en mal eller en poengtavle, si innholdet som naturlig, flytende tale.
- Still ett spørsmål om gangen, og vent på svaret. Et svar kan komme i flere biter med pauser; svar på helheten.
- Tilbakemelding: høyst rundt 150 ord. Karakterestimat, hva som satt, hva som mangler eller er feil (med riktig fakta), ett grep som løfter svaret til A, og et modellsvar på to til tre setninger. Still gjerne én oppfølging først, slik en sensor ville.
- Skriv standarder og paragrafer med sifre, slik de står i materialet (NS 8405, NLM 19, FOA § 13-2); stemmen uttaler dem riktig. Andre tall og satser skriver du slik de sies: «én promille per hverdag», «tema tre, spørsmål åtte».
- Bygg fakta på materialet under. Er du usikker eller mangler materialet svaret, si det; finn aldri på paragrafer, satser eller punkter.
- Han kan si «ferdig» når han er ferdig med et svar. Når han vil slutte («avslutt øvingen», «nok for i dag»), gi en kort oppsummering av sterke og svake tema og bruk stop_study.
- Ikke flørt i øvingsmodus; vær vennlig, men streng som en sensor.

MATERIALET:
${pack.text}`;
}
