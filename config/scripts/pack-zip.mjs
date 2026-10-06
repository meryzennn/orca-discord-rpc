import { execSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';

if (existsSync('OrcaPresence-windows.zip')) {
  unlinkSync('OrcaPresence-windows.zip');
}

execSync(
  'powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(\'dist-csharp\', \'OrcaPresence-windows.zip\')"',
  { stdio: 'inherit' }
);
console.log('Created OrcaPresence-windows.zip cleanly without root dot entry.');
