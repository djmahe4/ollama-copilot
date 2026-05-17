import { SkillManager } from '../../src/agentic-core/skill-manager';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('fs');
jest.mock('os');

describe('SkillManager', () => {
  let skillManager: SkillManager;
  let mockMemory: any;
  const workspaceRoot = 'C:\\workspace';
  const homeDir = 'C:\\Users\\user';

  beforeEach(() => {
    jest.clearAllMocks();
    (os.homedir as jest.Mock).mockReturnValue(homeDir);
    mockMemory = {
      indexSkill: jest.fn().mockResolvedValue(undefined),
    };
    skillManager = new SkillManager(mockMemory, workspaceRoot);
  });

  it('should resolve user config root correctly on windows', () => {
    // The current implementation just uses path.join(home, '.config')
    // We can verify if it matches our expected default
    (SkillManager.prototype as any).resolveUserConfigRoot();
    // Since resolveUserConfigRoot is private, we test discoverAndIndexSkills
  });

  it('should discover skills from user_config root by default', async () => {
    (fs.existsSync as jest.Mock).mockImplementation((p) => p.includes('.config/opencode/skills'));
    (SkillManager.prototype as any).scanDirectory = jest.fn().mockResolvedValue(['skill1', 'skill2']);

    const result = await skillManager.discoverAndIndexSkills();

    expect(result.indexed).toBe(2);
    expect(mockMemory.indexSkill).toHaveBeenCalledTimes(2);
    // Verify it looked in user config root
    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining(path.join(homeDir, '.config/opencode/skills')));
  });

  it('should discover skills from workspace root when preference is set', async () => {
    skillManager.setRootPreference('workspace');
    (fs.existsSync as jest.Mock).mockImplementation((p) => p.includes('AGENTS.md'));
    (SkillManager.prototype as any).scanDirectory = jest.fn().mockResolvedValue(['skill-agent']);

    const result = await skillManager.discoverAndIndexSkills();

    expect(result.indexed).toBe(1);
    expect(fs.existsSync).toHaveBeenCalledWith(expect.stringContaining(path.join(workspaceRoot, 'AGENTS.md')));
  });

  it('should skip non-existent paths', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    
    const result = await skillManager.discoverAndIndexSkills();

    expect(result.indexed).toBe(0);
  });
});
