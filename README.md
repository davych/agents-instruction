# Agents Instruction

A collection of GitHub Copilot agent configurations and instructions designed for efficient, context-aware software development.

## 📁 Project Structure

```
github-copilot/
├── copilot-instructions.md    # Core efficiency guidelines for Copilot
├── agents/
│   └── dev.agent.md           # Adaptive fullstack developer agent
├── templates/
│   └── quality.template.md    # Universal code quality standards
├── tasks/
│   └── .gitkeep
└── workflows/
    └── .gitkeep
```

## 🤖 Available Agents

### Dev Agent (James)

An adaptive fullstack developer agent that:
- **Auto-detects** project tech stack and architecture
- **Learns** from existing codebase patterns and conventions
- **Reviews PRs** with comprehensive diff analysis and quality assessment
- **Implements features** following workspace conventions
- **Enforces** Angular commit conventions

**Key Commands:**
- `help` - Show available commands
- `review-pr-diff` - Comprehensive PR review with quality assessment
- `develop-story` - Implement features based on descriptions
- `generate-record` - Generate completion records
- `exit` - Exit persona

## 📋 Copilot Instructions

Core principles for efficient AI assistance:

### Efficiency First
- ✅ Execute directly without unnecessary confirmations
- ✅ Use parallel tool calls for independent operations
- ✅ Provide complete working code (no placeholders)
- ✅ One-time context collection

### Communication Style
- Minimal responses for simple tasks
- Result-oriented (not process-oriented)
- No tool usage announcements

### Context Awareness
- Remember project structure after first interaction
- Auto-match code style and patterns
- No repeated questions for known information

## 🔧 Git Conventions

All commits follow **Angular Commit Convention**:

```
<type>(<scope>): <subject>

Types: feat, fix, docs, style, refactor, test, chore
```

**Examples:**
- `feat(auth): add JWT authentication`
- `fix(api): resolve null pointer exception in user service`
- `docs(readme): update installation instructions`

**Rules:**
- Use imperative mood
- Lowercase subject
- No period at end
- Keep under 72 characters
- Always use `git add .` for staging

## 🚀 Getting Started

1. **Copy agent configuration** to your project:
   ```bash
   cp github-copilot/agents/dev.agent.md your-project/.github/copilot-instructions.md
   ```

2. **Customize** for your project needs

3. **Activate** by chatting with GitHub Copilot and referencing the agent

## 💡 Usage Tips

### For PR Reviews
```
@dev review-pr-diff #123
```

### For Feature Implementation
```
@dev develop-story

Implement user authentication with JWT tokens
- Add login/logout endpoints
- Store tokens securely
- Add middleware for protected routes
```

## 📚 Templates

### Quality Template
Universal coding standards covering:
- TypeScript/JavaScript best practices
- Naming conventions
- Error handling patterns
- Testing standards
- Code documentation

## 🎯 Design Philosophy

1. **Framework Agnostic**: Auto-detects and adapts to any JS/TS stack
2. **Pattern Learning**: Learns from your existing codebase
3. **Action-Oriented**: Minimizes back-and-forth communication
4. **Quality Focused**: Enforces consistent code standards
5. **Git Standards**: Maintains clean commit history

## 📝 License

MIT

## 🤝 Contributing

Contributions welcome! Please follow the Angular commit convention when submitting PRs.
