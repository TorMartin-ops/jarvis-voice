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
  /** "rollespill": Jarvis plays the person the pack describes (a customer, an interviewer) instead of examining. */
  mode: "eksamen" | "rollespill";
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
    const raw = readFileSync(join(this.dir, `${hit.name}.md`), "utf8");
    const { mode, body } = splitFrontMatter(raw);
    return { ...hit, text: body, mode };
  }
}

function titleOf(md: string): string {
  return md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
}

/** An optional "---\nmodus: rollespill\n---" block at the top picks the session mode. */
export function splitFrontMatter(md: string): { mode: StudyPack["mode"]; body: string } {
  const m = md.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { mode: "eksamen", body: md };
  const mode = /^\s*modus\s*:\s*rollespill\s*$/im.test(m[1]) ? "rollespill" : "eksamen";
  return { mode, body: md.slice(m[0].length) };
}

/** System text for an active study session: voice rules first, then the pack itself. */
export function studyInstructions(pack: StudyPack): string {
  if (pack.mode === "rollespill") return roleplayInstructions(pack);
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

/** System text right after a role-play ends: the feedback, with the material it is based on. */
export function roleplayFeedbackInstructions(pack: StudyPack): string {
  return `ROLLESPILLET ER AVSLUTTET: ${pack.title}

Du er ute av rollen og er Jarvis igjen. Gi nå tilbakemeldingen materialet beskriver under «Tilbakemelding», basert på hele samtalen over. Vær ærlig og konkret, og gjengi hans egne formuleringer der materialet ber om det. Dette er tale: ingen markdown eller lister, bare flytende setninger, høyst rundt 450 ord. Du har allerede sagt at øvingen er avsluttet, så gå rett på tilbakemeldingen. Ikke bruk stop_study igjen.

MATERIALET:
${pack.text}`;
}

/**
 * A role-play session: Jarvis becomes the person in the pack (for example a customer before a sales
 * meeting) and stays in that role, without coaching, until he ends the practice. Feedback comes only then.
 */
export function roleplayInstructions(pack: StudyPack): string {
  return `ROLLESPILL: ${pack.title}

Reglene her gjelder foran alt annet i systemteksten, også personligheten din som Jarvis, så lenge rollespillet varer.
- Du er ikke Jarvis nå. Du ER personen materialet beskriver, og Tor Martin snakker med deg som i et ekte møte. Bli i rollen hele tiden. Ikke nevn at du er en KI, en assistent eller at dette er en øving, og ikke flørt.
- Dette er tale. Alt du sier leses opp. Bruk aldri markdown, lister eller overskrifter. Snakk som et menneske i et Teams-møte: vanligvis én til tre setninger, lengre bare når han stiller et åpent spørsmål som rollen har mye å svare på.
- Ikke hjelp ham og ikke gi tips, ros eller vurdering underveis, med mindre han selv ber om hjelp (se under). Svar på det han faktisk spør om. Det rollen vet, men som han ikke spør etter, holder du for deg selv slik materialet sier. Gode, konkrete spørsmål gir mer; generelle spørsmål gir korte, generelle svar.
- Vær realistisk: still dine egne spørsmål, ta opp bekymringene og innvendingene i materialet når de passer naturlig inn, avbryt høflig hvis han prater for lenge, og bli mer skeptisk hvis han lover noe materialet sier ikke finnes.
- Finn aldri på fakta om rollen, personen eller virksomheten. Spør han om noe materialet ikke dekker, svar slik en travel leder ville uten tallet foran seg («det har jeg ikke i hodet nå», «det må jeg sjekke»), eller spør hvorfor han lurer. Finn heller aldri på noe om produktet han selger.
- Sier han «hjelp», «Jarvis, hjelp meg», «time-out» eller spør hva han bør si: gå kort ut av rollen som Jarvis og gi ett konkret råd for akkurat dette øyeblikket i møtet, ut fra rådene og målet i materialet. Bruk én til tre setninger, gjerne med en setning han kan si ordrett. Ikke røp hva rollen tenker utover det rådet krever. Avslutt med «Tilbake til» og rollens fornavn, og fortsett i rollen der dere slapp.
- Et svar kan komme i flere biter med pauser; svar på helheten. Han kan si «ferdig» når han er ferdig med å snakke.
- Når han sier «avslutt øvingen», «stopp rollespillet» eller «nok for i dag»: bruk stop_study med en gang, uten å si noe først. Tilbakemeldingen gir du etterpå.

MATERIALET:
${pack.text}`;
}
