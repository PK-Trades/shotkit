// Text recognition using the OCR engine built into Windows 10/11 (Windows.Media.Ocr),
// invoked through Windows PowerShell so no extra native dependencies are needed.
import { app, clipboard, NativeImage } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage, notify } from './util';

const SCRIPT = [
  'param([string]$Path, [switch]$Words)',
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]',
  '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]',
  "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  'function Await($op, [Type]$type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])',
  '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  "if ($null -eq $engine) { [Console]::Error.WriteLine('No OCR language is installed in Windows.'); exit 2 }",
  '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  // -Words: one "lineIndex<TAB>x<TAB>y<TAB>w<TAB>h" row per word (invariant culture decimals).
  'if ($Words) {',
  '  $i = 0',
  '  foreach ($line in $result.Lines) {',
  '    foreach ($w in $line.Words) { $r = $w.BoundingRect; [string]::Format([Globalization.CultureInfo]::InvariantCulture, "{0}`t{1}`t{2}`t{3}`t{4}", $i, $r.X, $r.Y, $r.Width, $r.Height) }',
  '    $i++',
  '  }',
  '} else { $result.Lines | ForEach-Object { $_.Text } }',
].join('\r\n');

export interface WordBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function workDir(): string {
  const d = path.join(app.getPath('temp'), 'shotkit');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Runs Windows OCR; `scale` is how much the image was resized before recognition. */
async function runOcr(img: NativeImage, words: boolean): Promise<{ stdout: string; scale: number }> {
  let im = img;
  const originalWidth = im.getSize().width;
  let { width, height } = im.getSize();
  // Windows OCR does much better on small text when it's upscaled.
  if (Math.max(width, height) < 1500) {
    im = im.resize({ width: width * 2, height: height * 2, quality: 'best' });
    ({ width, height } = im.getSize());
  }
  const maxDim = 9000; // OcrEngine.MaxImageDimension is 10000
  if (Math.max(width, height) > maxDim) {
    const f = maxDim / Math.max(width, height);
    im = im.resize({ width: Math.floor(width * f), height: Math.floor(height * f), quality: 'best' });
  }

  const dir = workDir();
  const script = path.join(dir, 'ocr.ps1');
  fs.writeFileSync(script, SCRIPT);
  const file = path.join(dir, `ocr-${Date.now()}.png`);
  fs.writeFileSync(file, im.toPNG());
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', file];
  if (words) args.push('-Words');
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        args,
        { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || err.message).trim().split(/\r?\n/)[0]));
          else resolve(stdout);
        },
      );
    });
    return { stdout, scale: im.getSize().width / originalWidth };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function recognizeText(img: NativeImage): Promise<string> {
  return (await runOcr(img, false)).stdout;
}

/** Word boxes in image pixels, grouped by text line. */
export async function recognizeWords(img: NativeImage): Promise<WordBox[][]> {
  const { stdout, scale } = await runOcr(img, true);
  const lines: WordBox[][] = [];
  for (const row of stdout.split(/\r?\n/)) {
    const [li, x, y, w, h] = row.split('\t').map(Number);
    if (![li, x, y, w, h].every(Number.isFinite)) continue;
    (lines[li] ??= []).push({ x: x / scale, y: y / scale, w: w / scale, h: h / scale });
  }
  return lines.filter((l) => l?.length);
}

export async function ocrToClipboard(img: NativeImage) {
  try {
    const text = (await recognizeText(img)).replace(/\r\n/g, '\n').trim();
    if (!text) {
      notify('No text found', 'ShotKit could not detect any text in the selection.');
      return;
    }
    clipboard.writeText(text);
    notify('Text copied', text.length > 140 ? `${text.slice(0, 137)}…` : text);
  } catch (e) {
    notify('Text recognition failed', errorMessage(e));
  }
}
