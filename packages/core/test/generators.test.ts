import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  createGenerators,
  isValidIban,
  isValidLuhn,
  isValidSaId,
  isValidVat,
  saIdBirthDate,
  TEST_CARDS,
  totp,
} from '../src/data/generators.js';

describe('validators against published examples', () => {
  it('Luhn: the card-network test numbers', () => {
    for (const pan of Object.values(TEST_CARDS)) expect(isValidLuhn(pan)).toBe(true);
    expect(isValidLuhn('4242424242424241')).toBe(false);
  });

  it('IBAN: the ISO 13616 example numbers', () => {
    for (const iban of [
      'GB82WEST12345698765432',
      'DE89370400440532013000',
      'NL91ABNA0417164300',
      'GB82 WEST 1234 5698 7654 32',
    ]) {
      expect(isValidIban(iban)).toBe(true);
    }
    expect(isValidIban('GB82WEST12345698765431')).toBe(false);
  });

  it('SA ID: a well-known valid example and invalid ones', () => {
    expect(isValidSaId('8001015009087')).toBe(true);
    expect(saIdBirthDate('8001015009087')).toBe('1980-01-01');
    expect(isValidSaId('8001015009086')).toBe(false); // check digit
    expect(isValidSaId('8013015009081')).toBe(false); // month 13
    expect(isValidSaId('800101500908')).toBe(false); // length
  });

  it('German VAT (MOD 11,10): the BZSt example', () => {
    expect(isValidVat('DE136695976')).toBe(true);
    expect(isValidVat('DE136695975')).toBe(false);
  });

  it('TOTP: RFC 6238 appendix B vectors (SHA-1, 8 digits)', () => {
    const key = Buffer.from('12345678901234567890');
    expect(totp(key, { time: 59, digits: 8 })).toBe('94287082');
    expect(totp(key, { time: 1111111109, digits: 8 })).toBe('07081804');
    expect(totp(key, { time: 1234567890, digits: 8 })).toBe('89005924');
    expect(totp(key, { time: 20000000000, digits: 8 })).toBe('65353130');
  });

  it('base32 decodes authenticator secrets', () => {
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString()).toBe('12345678901234567890');
  });
});

describe('generators', () => {
  it('produce valid values', () => {
    const gen = createGenerators({ seed: 'test-1' });
    for (let i = 0; i < 50; i++) {
      expect(isValidSaId(gen.saId())).toBe(true);
      expect(isValidIban(gen.iban('DE'))).toBe(true);
      expect(isValidIban(gen.iban('GB'))).toBe(true);
      expect(isValidIban(gen.iban('NL'))).toBe(true);
      expect(isValidLuhn(gen.luhn(16, '4'))).toBe(true);
      expect(isValidVat(gen.vatNumber('DE'))).toBe(true);
    }
  });

  it('honour SA ID options', () => {
    const gen = createGenerators({ seed: 's' });
    const id = gen.saId({ born: '1990-04-12', gender: 'F', citizen: false });
    expect(id.slice(0, 6)).toBe('900412');
    expect(Number(id.slice(6, 10))).toBeLessThan(5000);
    expect(id[10]).toBe('1');
    expect(isValidSaId(id)).toBe(true);
  });

  it('are deterministic per seed and unique per call where they should be', () => {
    const a = createGenerators({ seed: 'same' });
    const b = createGenerators({ seed: 'same' });
    expect([a.saId(), a.iban(), a.phone()]).toEqual([b.saId(), b.iban(), b.phone()]);
    expect(a.email()).not.toBe(a.email());
    expect(createGenerators({ seed: 'other' }).saId()).not.toBe(createGenerators({ seed: 'same' }).saId());
  });

  it('use reserved fictional phone ranges', () => {
    const gen = createGenerators({ seed: 'p' });
    expect(gen.phone('US')).toMatch(/^\+1\d{3}5550(1\d\d)$/);
    expect(gen.phone('GB')).toMatch(/^\+447700900\d{3}$/);
    expect(gen.phone('ZA', { format: 'national' })).toMatch(/^0\d{2} \d{3} \d{4}$/);
  });

  it('call() dispatches by name, including custom generators', () => {
    const gen = createGenerators({ seed: 'c' });
    gen.register(
      'employeeNo',
      (_p, rand) =>
        `E${Math.floor(rand() * 1e6)
          .toString()
          .padStart(6, '0')}`,
    );
    expect(gen.call('employeeNo')).toMatch(/^E\d{6}$/);
    expect(isValidSaId(gen.call('saId', { born: '2001-02-03' }))).toBe(true);
    expect(() => gen.call('nope')).toThrow(/Unknown generator "nope"/);
  });
});
