const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getSkills } = require('../out/backend/skills');

function skill(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: scub ${name} skill\n---\nBody\n`);
}

test('linked skill folders are listed and non-skill folders are not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scub-skill-links-'));
  try {
    const skills = path.join(root, 'project', '.claude', 'skills');
    skill(path.join(skills, 'scub-real'), 'scub-real');
    // The reported case: a skill kept in a shared folder and linked in.
    skill(path.join(root, 'shared', 'scub-linked'), 'scub-linked');
    fs.symlinkSync(path.join(root, 'shared', 'scub-linked'), path.join(skills, 'scub-linked'), 'junction');
    // A link whose target was removed must not surface as a skill.
    skill(path.join(root, 'shared', 'scub-gone'), 'scub-gone');
    fs.symlinkSync(path.join(root, 'shared', 'scub-gone'), path.join(skills, 'scub-gone'), 'junction');
    fs.rmSync(path.join(root, 'shared', 'scub-gone'), { recursive: true });
    // The CLI's synced bucket is a folder without SKILL.md.
    fs.mkdirSync(path.join(skills, 'synced', 'scub-bucket'), { recursive: true });

    const listed = getSkills(path.join(root, 'project')).filter(s => s.scope === 'project');
    assert.deepEqual(listed.map(s => s.name).sort(), ['scub-linked', 'scub-real']);
    assert.equal(listed.find(s => s.name === 'scub-linked').description, 'scub scub-linked skill');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
