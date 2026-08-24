/**
 * Prompt Filter — Essai communautaire
 *
 * Upstream gate for the anonymous public trial: every generation is visible
 * to everyone, so prompts that would produce prohibited content are refused
 * BEFORE any provider call. Matching is accent-insensitive (FR) and
 * word-boundary based to avoid false positives ("Scunthorpe problem":
 * "assiette" must not match "ass").
 *
 * Categories (FR + EN): sexual content, minors in any risky combination,
 * graphic violence/gore, hate, real people/celebrities, identity documents.
 *
 * This is a keyword net, not a moral oracle — the public gallery + report
 * button + admin delete are the second and third layers.
 */

// Strip accents + lowercase for matching
function normalize(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\-./\\]+/g, ' ')   // "n-u-d-e" / "n.u.d.e" → "n u d e" stays split, but "photo-realiste" → "photo realiste"
    .replace(/\s+/g, ' ')
    .trim();
}

// Each entry is matched as a whole word (or exact phrase) on the normalized prompt.
const CATEGORIES = [
  {
    id: 'sexuel',
    label: 'contenu sexuel ou denude',
    terms: [
      // EN
      'nude', 'nudes', 'naked', 'nudity', 'nsfw', 'porn', 'porno', 'pornography', 'xxx',
      'topless', 'erotic', 'erotica', 'sexual', 'sex act', 'sex scene', 'explicit', 'hentai',
      'lingerie model', 'strip', 'stripper', 'undressed', 'genitals', 'breasts exposed', 'fetish',
      // FR
      'nu', 'nue', 'nus', 'nues', 'nudite', 'denude', 'denudee', 'pornographique', 'pornographie',
      'erotique', 'sexuel', 'sexuelle', 'scene de sexe', 'seins nus', 'deshabille', 'deshabillee',
      'fetichiste', 'sans vetements', 'sans vetement',
    ],
  },
  {
    id: 'mineurs',
    label: 'implication de mineurs',
    terms: [
      // Any minor-related term is refused outright in an anonymous public trial —
      // the safe move is to keep children out of the communal wall entirely.
      'child', 'children', 'kid', 'kids', 'minor', 'minors', 'teen', 'teenager', 'underage',
      'schoolgirl', 'schoolboy', 'toddler', 'baby girl', 'baby boy', 'loli', 'shota',
      'enfant', 'enfants', 'mineur', 'mineure', 'mineurs', 'adolescent', 'adolescente',
      'ecolier', 'ecoliere', 'fillette', 'garconnet', 'bebe fille', 'bebe garcon',
    ],
  },
  {
    id: 'violence',
    label: 'violence graphique',
    terms: [
      'gore', 'blood bath', 'bloodbath', 'beheading', 'beheaded', 'decapitation', 'dismember',
      'dismembered', 'mutilation', 'mutilated', 'torture', 'tortured', 'corpse', 'dead body',
      'massacre', 'execution', 'lynching', 'guts', 'entrails', 'severed head', 'school shooting',
      'decapite', 'decapitation', 'demembrement', 'demembre', 'mutile', 'mutilee', 'cadavre',
      'corps mutile', 'bain de sang', 'egorge', 'egorgee', 'tuerie', 'fusillade', 'entrailles',
      'tete coupee', 'ensanglante', 'ensanglantee',
    ],
  },
  {
    id: 'haine',
    label: 'contenu haineux',
    terms: [
      'nazi', 'swastika', 'hitler', 'kkk', 'ku klux klan', 'white power', 'ethnic cleansing',
      'racial slur', 'hate symbol', 'holocaust denial',
      'croix gammee', 'suprematie blanche', 'suprematiste', 'epuration ethnique',
      'symbole haineux', 'negationnisme',
    ],
  },
  {
    id: 'personnes-reelles',
    label: 'personnes reelles ou celebrites',
    terms: [
      // Generic markers — the trial refuses depiction requests of real, named people.
      'celebrity', 'celebrities', 'famous person', 'famous people', 'real person', 'politician',
      'president of', 'deepfake', 'face swap', 'faceswap', 'lookalike of',
      'celebrite', 'celebrites', 'personne reelle', 'personne celebre', 'personnalite publique',
      'homme politique', 'femme politique', 'president de', 'sosie de',
      // A short list of very common targets — not exhaustive, the report button covers the rest.
      'trump', 'macron', 'obama', 'biden', 'putin', 'poutine', 'elon musk', 'zidane', 'mbappe',
      'taylor swift', 'beyonce', 'rihanna', 'kim kardashian', 'brad pitt', 'angelina jolie',
      'emma watson', 'scarlett johansson', 'cristiano ronaldo', 'messi', 'zelensky', 'pape francois',
    ],
  },
  {
    id: 'documents',
    label: 'documents d\'identite ou officiels',
    terms: [
      'passport', 'id card', 'identity card', 'driver license', 'drivers license', 'driving licence',
      'green card', 'visa document', 'birth certificate', 'social security card', 'bank statement',
      'credit card number', 'banknote', 'currency bill', 'counterfeit',
      'passeport', 'carte d identite', 'carte identite', 'permis de conduire', 'carte vitale',
      'carte grise', 'acte de naissance', 'carte bancaire', 'billet de banque', 'faux billet',
      'faux document', 'fausse carte', 'diplome officiel', 'tampon officiel',
    ],
  },
];

// Precompile one regex per category: exact phrases and single words, both word-bounded.
const COMPILED = CATEGORIES.map((cat) => {
  const parts = cat.terms
    .map((t) => normalize(t))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length) // longest first — phrases win over sub-words
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  return {
    id: cat.id,
    label: cat.label,
    re: new RegExp(`(?:^|[^a-z0-9])(?:${parts.join('|')})(?:$|[^a-z0-9])`, 'i'),
  };
});

/**
 * Check a prompt against the banned list.
 * @param {string} prompt
 * @returns {{ blocked: boolean, category?: string, message?: string }}
 */
export function checkPrompt(prompt) {
  const norm = ` ${normalize(prompt)} `;
  for (const cat of COMPILED) {
    if (cat.re.test(norm)) {
      return {
        blocked: true,
        category: cat.id,
        message: `Ce prompt n'est pas accepte dans l'essai communautaire (${cat.label}). Toutes les creations sont publiques ici — reformulez votre idee et reessayez.`,
      };
    }
  }
  return { blocked: false };
}
