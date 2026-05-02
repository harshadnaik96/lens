# 🤝 Contributing to Lens

Thank you for your interest in making **Lens** even better! This project thrives on community-driven improvements, especially in the form of new **Skill Packs**.

## 🧩 Adding a New Skill Pack

Skill packs are the heart of Lens's intelligence. They provide the model with language-specific or framework-specific checklists to look for during a review.

### 1. Create the File
Add a new Markdown file in the `skills/` directory named after the language extension (e.g., `ruby.md`, `rust.md`).

### 2. Structure the Content
Use the following format to ensure the model can parse the guidance effectively. Categorize your tips into the five core "Lenses":

```markdown
# [Language Name] Review

## [correctness]
- Common bugs, logic errors, or language-specific gotchas.

## [security]
- Injection risks, unsafe function calls, or data exposure.

## [data_integrity]
- Concurrency issues, race conditions, or state mutation bugs.

## [api_contracts]
- Breaking changes, type safety issues, or public API violations.

## [maintainability]
- Code smells, complex nesting, or poor naming.
```

### 3. Register the Skill (Optional)
The system automatically picks up files in `skills/` if they match the extension of a file in the PR diff.

---

## 🛠️ Development Setup

1.  **Fork & Clone**:
    ```bash
    git clone https://github.com/your-username/do-more-agent.git
    cd do-more-agent
    ```
2.  **Install Dependencies**:
    ```bash
    npm install
    ```
3.  **Build in Watch Mode**:
    ```bash
    npm run build -- --watch
    ```
4.  **Test Locally**:
    Use `npm link` to test the `lens` command globally while you develop.

## 📜 Code of Conduct
Please be respectful and constructive in all interactions within this project.

---

**Happy Reviewing!** 🚀
