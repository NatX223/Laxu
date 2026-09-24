import { badRequest, serviceUnavailable } from "../lib/errors";
import { createLogger } from "../lib/logger";

/**
 * @handles. Letters only -- no digits, in generated defaults or chosen ones:
 * lowercase words joined by single underscores, 3-20 characters.
 */

const log = createLogger("tags");

export const TAG_REGEX = /^[a-z]+(_[a-z]+)*$/;
export const TAG_MIN = 3;
export const TAG_MAX = 20;

/// Every word is lowercase letters, at most 8 long. Two words are then at most
/// 17 characters; three can reach 26, so the three-word fallback re-draws until
/// it fits (see threeWordTag).
export const ADJECTIVES = [
  "agile", "airy", "amber", "ample", "azure", "balmy", "bold", "bouncy",
  "brave", "breezy", "bright", "brisk", "bubbly", "calm", "candid", "carefree",
  "cheerful", "chilly", "civic", "classic", "clever", "cloudy", "coastal", "cobalt",
  "coral", "cosmic", "cozy", "crafty", "crimson", "crisp", "curious", "dainty",
  "dapper", "dashing", "dazzling", "deft", "dewy", "dreamy", "dusky", "dusty",
  "eager", "early", "earnest", "easy", "elated", "electric", "elegant", "epic",
  "fabled", "fair", "fancy", "fearless", "feisty", "fiery", "fleet", "fluffy",
  "fond", "frank", "fresh", "frisky", "frosty", "fuzzy", "gallant", "gentle",
  "giddy", "gilded", "glad", "gleaming", "glossy", "golden", "graceful", "grand",
  "green", "happy", "hardy", "hazy", "hearty", "hidden", "honest", "humble",
  "humming", "icy", "indigo", "ivory", "jade", "jaunty", "jazzy", "jolly",
  "jovial", "joyful", "jumpy", "keen", "kind", "kindly", "lanky", "little",
  "lively", "lofty", "loyal", "lucid", "lucky", "lunar", "lush", "magic",
  "majestic", "mellow", "merry", "mighty", "mint", "misty", "modest", "mossy",
  "nimble", "noble", "nomadic", "nordic", "novel", "oaken", "olive", "opal",
  "orange", "pastel", "peppy", "perky", "placid", "plucky", "plush", "polar",
  "polite", "prime", "proud", "quaint", "quick", "quiet", "quirky", "radiant",
  "rapid", "regal", "rosy", "royal", "ruby", "rugged", "rustic", "rusty",
  "sable", "sage", "sandy", "savvy", "scarlet", "serene", "shiny", "silent",
  "silver", "sleek", "smooth", "snappy", "snowy", "solar", "sonic", "spicy",
  "spry", "steady", "stellar", "stormy", "stout", "sturdy", "sunny", "swift",
  "tawny", "teal", "tender", "thrifty", "tidal", "tiny", "tranquil", "trusty",
  "umber", "upbeat", "urban", "velvet", "violet", "vital", "vivid", "warm",
  "wavy", "wild", "windy", "wise", "witty", "woolly", "zany", "zealous",
  "zesty", "zippy",
] as const;

export const NOUNS = [
  "acorn", "anchor", "aspen", "badger", "basin", "bay", "beacon", "beaver",
  "birch", "bison", "bobcat", "bramble", "breeze", "brook", "butte", "canyon",
  "cavern", "cedar", "cinder", "cliff", "cloud", "clover", "comet", "cove",
  "crane", "creek", "dawn", "delta", "dolphin", "dune", "dusk", "eagle",
  "egret", "elk", "ember", "falcon", "fern", "ferret", "finch", "fjord",
  "fox", "frost", "gable", "galaxy", "gecko", "geyser", "glacier", "glade",
  "gopher", "grove", "harbor", "harvest", "hawk", "heath", "heron", "hollow",
  "horizon", "ibis", "inlet", "island", "jackal", "jaguar", "juniper", "kestrel",
  "koala", "lagoon", "lake", "lantern", "lark", "lemur", "lichen", "lotus",
  "lynx", "magpie", "maple", "marmot", "marsh", "marten", "meadow", "meridian",
  "mesa", "mink", "mist", "moose", "narwhal", "nebula", "nectar", "newt",
  "nimbus", "oak", "oasis", "ocelot", "orbit", "orca", "orchard", "osprey",
  "otter", "owl", "panda", "panther", "parrot", "peak", "pebble", "pelican",
  "penguin", "pier", "pine", "pond", "poppy", "prairie", "puffin", "quail",
  "quarry", "quasar", "rabbit", "rain", "rapids", "raven", "reef", "ridge",
  "river", "robin", "salmon", "sapling", "shore", "shrike", "sierra", "sky",
  "spark", "sparrow", "spruce", "squid", "star", "stork", "storm", "stream",
  "summit", "swan", "tapir", "tern", "thicket", "thistle", "thunder", "tide",
  "tiger", "timber", "toucan", "trail", "trout", "tulip", "tundra", "turtle",
  "upland", "valley", "vector", "vista", "walrus", "willow", "wombat", "wren",
  "yak", "zebra", "zenith",
] as const;

const pick = <T>(list: readonly T[], random: () => number): T => list[Math.floor(random() * list.length)];

export function twoWordTag(random: () => number = Math.random): string {
  return `${pick(ADJECTIVES, random)}_${pick(NOUNS, random)}`;
}

/// Two different adjectives and a noun, re-drawn until it fits TAG_MAX.
export function threeWordTag(random: () => number = Math.random): string {
  for (;;) {
    const first = pick(ADJECTIVES, random);
    const second = pick(ADJECTIVES, random);
    if (first === second) continue;
    const tag = `${first}_${second}_${pick(NOUNS, random)}`;
    if (tag.length <= TAG_MAX) return tag;
  }
}

export const TWO_WORD_TRIES = 5;
export const THREE_WORD_TRIES = 5;

/**
 * Hands generated tags to `attempt` until one sticks: 5 two-word tries, then 5
 * three-word ones. `attempt` returns "taken" on a unique-tag collision (and may
 * return anything else, e.g. a user row, to stop). All 10 taken is a 503 --
 * practically unreachable at 30k+ two-word combinations.
 */
export async function allocateTag<T>(
  attempt: (tag: string) => Promise<T | "taken">,
  random: () => number = Math.random,
): Promise<T> {
  const tries = [
    ...Array.from({ length: TWO_WORD_TRIES }, () => twoWordTag),
    ...Array.from({ length: THREE_WORD_TRIES }, () => threeWordTag),
  ];
  for (const generate of tries) {
    const result = await attempt(generate(random));
    if (result !== "taken") return result;
  }
  log.error("could not allocate a unique tag", { tries: tries.length });
  throw serviceUnavailable("Could not allocate a username, try again", "TAG_EXHAUSTED");
}

/**
 * A user-chosen tag: "@" stripped, trimmed, lowercased, then checked. Returns
 * the tag to store or throws a 400 carrying the message the form shows.
 */
export function normaliseTag(raw: string): string {
  const tag = raw.trim().replace(/^@/, "").toLowerCase();
  if (/[^a-z_]/.test(tag)) {
    throw badRequest("Only letters and underscores — no numbers or spaces", "INVALID_TAG_CHARS");
  }
  if (tag.length < TAG_MIN || tag.length > TAG_MAX) {
    throw badRequest(`${TAG_MIN}–${TAG_MAX} characters`, "INVALID_TAG_LENGTH");
  }
  if (!TAG_REGEX.test(tag)) {
    throw badRequest("Underscores only go between letters, one at a time", "INVALID_TAG_UNDERSCORE");
  }
  return tag;
}

/// Users created under the old `[a-z0-9_]` rule -- see scripts/fix-numeric-tags.ts.
export const hasDigit = (tag: string): boolean => /\d/.test(tag);

/// Prisma's unique-constraint violation, narrowed to the `tag` column.
export function isTagCollision(error: unknown): boolean {
  const e = error as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== "P2002") return false;
  const target = e.meta?.target;
  return Array.isArray(target) ? target.includes("tag") : String(target ?? "").includes("tag");
}
