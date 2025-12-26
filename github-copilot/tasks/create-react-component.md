---
id: create-react-component
title: Create React Component
category: task
purpose: React component scaffolding task - standardized component file structure, type definitions, test files
---

# Task: Create React Component

## Pre-requisites

Before creating:
1. Confirm component name and target location with user
2. Check project structure for existing patterns
3. Check package.json for dependencies
4. Identify project's CSS approach


## Required Inputs

| Input | Required | Note |
|-------|----------|------|
| componentName | Yes | PascalCase |
| targetPath | Yes | User specified or infer from context |
| purpose | Yes | Brief description |


## Files to Create

Based on project conventions, typically include:

| File | Purpose |
|------|---------|
| index.ts | Public exports |
| {ComponentName}.tsx | Component implementation |
| {ComponentName}.types.ts | TypeScript types |
| {ComponentName}.test.tsx | Tests (if project has testing) |
| [styles] | Based on project CSS approach |

Adapt file structure to match existing project patterns.


## Execution

### 1. Create Types

#tool:write `{targetPath}/{ComponentName}.types.ts`

Define props interface extending appropriate HTML attributes.


### 2. Create Component

#tool:write `{targetPath}/{ComponentName}.tsx`

Follow react.template.md component structure guidelines.


### 3. Create Index

#tool:write `{targetPath}/index.ts`

Export component and types.


### 4. Create Test (if applicable)

#tool:write `{targetPath}/{ComponentName}.test.tsx`

Basic render and behavior tests.


### 5. Create Styles (if applicable)

Based on project's CSS approach.


### 6. Verify

#tool:execute type check

Confirm no TypeScript errors.


## Output

Report created files and import path.