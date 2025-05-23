# My Obsidian Plugin

## Overview
This is a plugin for Obsidian that enhances your note-taking experience by providing additional features and functionalities.

## Features
- Summarize Week: Extracts content under configurable headers from daily notes to create a weekly summary.
- Eisenhower Matrix: Categorizes tasks by importance and urgency, with both Markdown and HTML visualizations.
  - Includes color-coded quadrants and clickable tasks that open the original file.
  - Supports emoji customization for importance, urgency, and duration.
  - Filters tasks to include only those not marked as done.

## Installation
1. Download the plugin files.
2. Place the plugin folder in your Obsidian plugins directory.
3. Enable the plugin in the Obsidian settings under the "Community Plugins" section.

## Usage
- **Summarize Week**: Use the command palette to run the "Summarize Week" command. It extracts content from recent notes and copies a summary prompt to the clipboard.
- **Eisenhower Matrix**: Use the command palette to run the "Show Eisenhower Matrix" command. It generates a matrix of tasks categorized by importance and urgency, displayed in both Markdown and HTML formats.

## Eisenhower Matrix Visualization

![Eisenhower Matrix](matrix.png)
## Example Tasks
Here are some example tasks to demonstrate how to use the Eisenhower Matrix:

### Example 1: Urgent and Important
```markdown
- [ ] Complete project report 🔥⭐ importance::high urgency::high
```

### Example 2: Not Urgent but Important
```markdown
- [ ] Plan next week's schedule ⭐ importance::high urgency::low
```

### Example 3: Urgent but Not Important
```markdown
- [ ] Respond to client email 🔥 importance::low urgency::high
```

### Example 4: Neither Urgent nor Important
```markdown
- [ ] Organize desk importance::low urgency::low
```

## Contributing
If you would like to contribute to this project, please fork the repository and submit a pull request.

## License
This project is licensed under the MIT License. See the LICENSE file for more details.
