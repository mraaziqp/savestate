const { path7za } = require('7zip-bin');
const { execSync } = require('child_process');
const fs = require('fs');

try {
  console.log(execSync(`"${path7za}" x -otemp_out releases/updates/SaveState-Setup-1.0.70.exe -y`, { encoding: 'utf8' }));
  console.log('Files in temp_out:', fs.readdirSync('temp_out'));
} catch (e) {
  console.log('Error:', e.message);
}
