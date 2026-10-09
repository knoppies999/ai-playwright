// Test-data generators and validators (docs/08 §3). "The model chooses where values go; code produces
// the values." Seeded per test so a rerun (or a nudge rewind) reproduces the same data. No faker
// dependency: a small PRNG and short word lists are enough for valid, varied test data.
import { createHash, createHmac, randomUUID } from 'node:crypto';

/** mulberry32: small, fast, deterministic. */
export function seededRandom(seed: string): () => number {
  let a = createHash('sha1').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Luhn -------------------------------------------------------------------------------------------

export function luhnCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidLuhn(value: string): boolean {
  const digits = value.replace(/\s|-/g, '');
  return /^\d{2,}$/.test(digits) && luhnCheckDigit(digits.slice(0, -1)) === Number(digits.slice(-1));
}

/** Published card-network test numbers (Stripe-style test PANs): Luhn-valid and never real cards. */
export const TEST_CARDS = {
  visa: '4242424242424242',
  visa_debit: '4000056655665556',
  mastercard: '5555555555554444',
  amex: '378282246310005',
  discover: '6011111111111117',
} as const;

// --- South African ID number -----------------------------------------------------------------------

/** YYMMDD SSSS C A Z: date of birth, gender (0000–4999 F, 5000–9999 M), citizenship (0/1), 8, Luhn digit. */
export function isValidSaId(id: string): boolean {
  if (!/^\d{13}$/.test(id) || !isValidLuhn(id)) return false;
  const [yy, mm, dd] = [id.slice(0, 2), id.slice(2, 4), id.slice(4, 6)].map(Number) as [number, number, number];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const date = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  if (date.getUTCMonth() !== mm - 1) {
    const old = new Date(Date.UTC(1900 + yy, mm - 1, dd));
    if (old.getUTCMonth() !== mm - 1) return false;
  }
  return id[10] === '0' || id[10] === '1';
}

export function saIdBirthDate(id: string): string {
  const yy = Number(id.slice(0, 2));
  const year = yy > new Date().getUTCFullYear() % 100 ? 1900 + yy : 2000 + yy;
  return `${year}-${id.slice(2, 4)}-${id.slice(4, 6)}`;
}

// --- IBAN (ISO 13616, mod 97) ---------------------------------------------------------------------

/** BBAN layouts: n = digit, a = upper-case letter. */
const IBAN_LAYOUTS: Record<string, string> = {
  DE: 'nnnnnnnnnnnnnnnnnn', // 8 bank + 10 account
  GB: 'aaaannnnnnnnnnnnnn', // 4 bank + 6 sort code + 8 account
  NL: 'aaaannnnnnnnnn', // 4 bank + 10 account
  FR: 'nnnnnnnnnnnnnnnnnnnnnnn', // simplified: digits only
  ES: 'nnnnnnnnnnnnnnnnnnnn',
};

function mod97(numeric: string): number {
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem;
}

const ibanNumeric = (s: string) => s.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));

export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) return false;
  return mod97(ibanNumeric(iban.slice(4) + iban.slice(0, 4))) === 1;
}

// --- German VAT (USt-IdNr, ISO 7064 MOD 11,10) ---------------------------------------------------------

function mod11_10Check(digits: string): number {
  let product = 10;
  for (const d of digits) {
    let sum = (Number(d) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  const check = 11 - product;
  return check === 10 ? 0 : check;
}

export function isValidVat(value: string): boolean {
  const v = value.replace(/\s/g, '').toUpperCase();
  if (/^DE\d{9}$/.test(v)) return mod11_10Check(v.slice(2, 10)) === Number(v[10]);
  if (/^(ZA)?4\d{9}$/.test(v)) return true; // SA VAT: 10 digits starting with 4; no public checksum
  return false;
}

// --- TOTP (RFC 6238) -------------------------------------------------------------------------------

export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = '';
  for (const c of clean) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error(`Invalid base32 character "${c}"`);
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((b) => parseInt(b, 2)));
}

/** RFC 6238 TOTP. `key` is the raw secret; use base32Decode for authenticator-style secrets. */
export function totp(
  key: Buffer,
  options: { time?: number; step?: number; digits?: number; algorithm?: 'sha1' | 'sha256' | 'sha512' } = {},
): string {
  const { time = Date.now() / 1000, step = 30, digits = 6, algorithm = 'sha1' } = options;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / step)));
  const hmac = createHmac(algorithm, key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

// --- Generators ------------------------------------------------------------------------------------

const FIRST = [
  'Thandi',
  'Sipho',
  'Lerato',
  'Johan',
  'Ayanda',
  'Priya',
  'Pieter',
  'Naledi',
  'Kagiso',
  'Zanele',
  'Ruan',
  'Fatima',
];
const LAST = [
  'Mokoena',
  'Dlamini',
  'Naidoo',
  'van der Merwe',
  'Nkosi',
  'Botha',
  'Khumalo',
  'Pillay',
  'Smith',
  'Mahlangu',
];
const STREETS = ['Main Road', 'Church Street', 'Long Street', 'Jan Smuts Avenue', 'Oxford Road', 'Beach Road'];
const CITIES: Record<string, [string, string][]> = {
  ZA: [
    ['Johannesburg', '2196'],
    ['Cape Town', '8001'],
    ['Durban', '4001'],
    ['Pretoria', '0002'],
  ],
  US: [
    ['Springfield', '62701'],
    ['Austin', '73301'],
  ],
  GB: [
    ['London', 'SW1A 1AA'],
    ['Manchester', 'M1 1AE'],
  ],
};
const WORDS = [
  'alpha',
  'river',
  'stone',
  'cloud',
  'maple',
  'orbit',
  'pixel',
  'quartz',
  'cedar',
  'harbor',
  'lumen',
  'delta',
];

export interface Person {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
}

export interface Generators {
  /** Unique per run and call: aipw+<run>-<n>@example.com */
  email(options?: { domain?: string }): string;
  phone(country?: 'ZA' | 'US' | 'GB', options?: { format?: 'e164' | 'national' }): string;
  saId(options?: { born?: string; gender?: 'F' | 'M'; citizen?: boolean }): string;
  luhn(length?: number, prefix?: string): string;
  testCard(brand?: keyof typeof TEST_CARDS): string;
  iban(country?: string): string;
  vatNumber(country?: 'DE' | 'ZA'): string;
  date(options?: { from?: string; to?: string; format?: 'iso' | 'dmy' | 'mdy' }): string;
  uuid(): string;
  slug(words?: number): string;
  words(n?: number): string;
  person(country?: 'ZA' | 'US' | 'GB'): Person;
  address(country?: 'ZA' | 'US' | 'GB'): { street: string; city: string; postalCode: string; country: string };
  /** Current TOTP for a base32 secret held in an environment variable (treated as a secret by callers). */
  totp(envVar: string): string;
  /** Adds a custom generator, callable as gen.call('name', params) and {{gen.name(...)}}. */
  register(name: string, fn: (params: Record<string, unknown>, rand: () => number) => string): void;
  /** Calls any generator by name with JSON-style params (used by generate_value and {{gen.*}}). */
  call(kind: string, params?: Record<string, unknown>): string;
}

export function createGenerators(options: { seed: string; runId?: string } = { seed: 'aipw' }): Generators {
  const rand = seededRandom(options.seed);
  const runId =
    options.runId ??
    options.seed
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8)
      .toLowerCase();
  let emailCount = 0;
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(list: readonly T[]) => list[int(0, list.length - 1)]!;
  const digits = (n: number) => Array.from({ length: n }, () => String(int(0, 9))).join('');
  const custom = new Map<string, (params: Record<string, unknown>, rand: () => number) => string>();

  const gen: Generators = {
    email: ({ domain = 'example.com' } = {}) => `aipw+${runId}-${++emailCount}@${domain}`,
    phone(country = 'ZA', { format = 'e164' } = {}) {
      if (country === 'US') {
        // 555-0100…0199 is reserved for fiction.
        const n = `${int(201, 989)}5550${int(100, 199)}`;
        return format === 'e164' ? `+1${n}` : `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
      }
      if (country === 'GB') {
        // Ofcom's 07700 900000–900999 range is reserved for drama.
        const n = `7700900${digits(3)}`;
        return format === 'e164' ? `+44${n}` : `0${n.slice(0, 4)} ${n.slice(4)}`;
      }
      const n = `${pick(['60', '61', '71', '72', '73', '74', '76', '79', '81', '82', '83', '84'])}${digits(7)}`;
      return format === 'e164' ? `+27${n}` : `0${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`;
    },
    saId({ born, gender, citizen = true } = {}) {
      const date = born ?? gen.date({ from: '1950-01-01', to: '2005-12-31' });
      const [y, m, d] = date.split('-');
      const g = gender ?? pick(['F', 'M'] as const);
      const seq = String(g === 'F' ? int(0, 4999) : int(5000, 9999)).padStart(4, '0');
      const body = `${y!.slice(2)}${m}${d}${seq}${citizen ? '0' : '1'}8`;
      return `${body}${luhnCheckDigit(body)}`;
    },
    luhn(length = 16, prefix = '') {
      const body = prefix + digits(Math.max(0, length - prefix.length - 1));
      return `${body}${luhnCheckDigit(body)}`;
    },
    testCard: (brand = 'visa') => TEST_CARDS[brand],
    iban(country = 'DE') {
      const layout = IBAN_LAYOUTS[country];
      if (!layout) throw new Error(`No IBAN layout for ${country}. Known: ${Object.keys(IBAN_LAYOUTS).join(', ')}`);
      const bban = [...layout]
        .map((c) => (c === 'n' ? String(int(0, 9)) : String.fromCharCode(65 + int(0, 25))))
        .join('');
      const check = 98 - mod97(ibanNumeric(`${bban}${country}00`));
      return `${country}${String(check).padStart(2, '0')}${bban}`;
    },
    vatNumber(country = 'DE') {
      if (country === 'ZA') return `4${digits(9)}`;
      const body = `${int(1, 9)}${digits(7)}`;
      return `DE${body}${mod11_10Check(body)}`;
    },
    date({ from = '1970-01-01', to = '2005-12-31', format = 'iso' } = {}) {
      const a = Date.parse(`${from}T00:00:00Z`);
      const b = Date.parse(`${to}T00:00:00Z`);
      const iso = new Date(a + Math.floor(rand() * (b - a + 1))).toISOString().slice(0, 10);
      const [y, m, d] = iso.split('-');
      return format === 'dmy' ? `${d}/${m}/${y}` : format === 'mdy' ? `${m}/${d}/${y}` : iso;
    },
    uuid: () => randomUUID(),
    slug: (n = 2) => `${Array.from({ length: n }, () => pick(WORDS)).join('-')}-${digits(4)}`,
    words: (n = 3) => Array.from({ length: n }, () => pick(WORDS)).join(' '),
    person(country = 'ZA') {
      const firstName = pick(FIRST);
      const lastName = pick(LAST);
      return {
        firstName,
        lastName,
        email: gen.email(),
        phone: gen.phone(country),
        dateOfBirth: gen.date({ from: '1960-01-01', to: '2004-12-31' }),
      };
    },
    address(country = 'ZA') {
      const [city, postalCode] = pick(CITIES[country] ?? CITIES.ZA!);
      return { street: `${int(1, 250)} ${pick(STREETS)}`, city, postalCode, country };
    },
    totp(envVar) {
      const secret = process.env[envVar];
      if (!secret) throw new Error(`Set ${envVar} to the base32 TOTP secret of the test account.`);
      return totp(base32Decode(secret));
    },
    register(name, fn) {
      custom.set(name, fn);
    },
    call(kind, params = {}) {
      const fn = custom.get(kind);
      if (fn) return fn(params, rand);
      const p = params as never;
      switch (kind) {
        case 'email':
          return gen.email(p);
        case 'phone':
          return gen.phone((params.country as 'ZA') ?? 'ZA', p);
        case 'saId':
          return gen.saId(p);
        case 'luhn':
          return gen.luhn(params.length as number, params.prefix as string);
        case 'testCard':
          return gen.testCard((params.brand as keyof typeof TEST_CARDS) ?? 'visa');
        case 'iban':
          return gen.iban((params.country as string) ?? 'DE');
        case 'vatNumber':
          return gen.vatNumber((params.country as 'DE') ?? 'DE');
        case 'date':
          return gen.date(p);
        case 'uuid':
          return gen.uuid();
        case 'slug':
          return gen.slug(params.words as number);
        case 'words':
          return gen.words(params.n as number);
        case 'firstName':
          return gen.person().firstName;
        case 'lastName':
          return gen.person().lastName;
        default:
          throw new Error(
            `Unknown generator "${kind}". Known: email, phone, saId, luhn, testCard, iban, vatNumber, date, uuid, slug, words, firstName, lastName${custom.size ? `, ${[...custom.keys()].join(', ')}` : ''}.`,
          );
      }
    },
  };
  return gen;
}

export const GENERATOR_KINDS = [
  'email',
  'phone',
  'saId',
  'luhn',
  'testCard',
  'iban',
  'vatNumber',
  'date',
  'uuid',
  'slug',
  'words',
  'firstName',
  'lastName',
] as const;
