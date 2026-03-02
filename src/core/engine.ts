export class Engine {
  private generateProgressChecklist(tasksSection: string): string {
    return tasksSection
      .split('\n')
      .filter(line => line.trim())
      .map(line => `- [ ] ${line.replace(/- ?\[(x|X| )\] ?/, '').trim()}`)
      .join('\n');
  }
}