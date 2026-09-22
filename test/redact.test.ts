import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSensitive, OcrWord } from '../src/renderer/editor/redact';

// Fake OCR: 10 px per character, words separated by 10 px.
function line(text: string): OcrWord[] {
  let x = 0;
  return text.split(' ').map((t) => {
    const w = { x, y: 0, w: t.length * 10, h: 20, text: t };
    x += t.length * 10 + 10;
    return w;
  });
}

const kinds = (text: string) => findSensitive([line(text)]).map((f) => f.kind);

test('finds emails, keys, card numbers, IBANs, phone numbers and IPs', () => {
  assert.deepEqual(kinds('Contact: john.doe@example.com today'), ['email']);
  assert.deepEqual(kinds('Card 4111 1111 1111 1111 exp 12/27'), ['card number']);
  assert.deepEqual(kinds('IBAN NL91 ABNA 0417 1643 00'), ['IBAN']);
  assert.deepEqual(kinds('Call +31 6 1234 5678 now'), ['phone number']);
  assert.deepEqual(kinds('Server 192.168.1.20 is up'), ['IP address']);
  assert.deepEqual(kinds('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'), ['API key']);
  assert.deepEqual(kinds('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), ['API key']);
});

test('leaves ordinary text alone', () => {
  assert.deepEqual(kinds('Card 4111 1111 1111 1112 fails the checksum'), []);
  assert.deepEqual(kinds('Version 10.0.26100 build'), []);
  assert.deepEqual(kinds('Date 2026-09-23 10:30:12 log'), []);
  assert.deepEqual(kinds('Total 1234567 items'), []);
  assert.deepEqual(kinds('getElementByIdentifierWithAVeryLongName'), []);
});

test('boxes only the matching part of a word', () => {
  const [f] = findSensitive([line('Email:john@x.io')]);
  assert.ok(f.box.x > 50 && f.box.x < 60, `box starts at the email, not the word (${f.box.x})`);
});
