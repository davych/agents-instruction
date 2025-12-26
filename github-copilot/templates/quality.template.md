---
id: quality-template
title: Code Quality Standards
category: template
purpose: Universal coding fundamentals - TypeScript standards, naming conventions, error handling, testing standards, code documentation
---

# Code Quality Standards

## Core Principles

| Principle | Description | Violation Example |
|-----------|-------------|-------------------|
| SRP | Single Responsibility - each file/function/class does ONE thing | A function that fetches data AND formats AND saves to cache |
| DRY | Don't Repeat Yourself - abstract shared logic | Same validation logic copy-pasted in 5 files |
| KISS | Keep It Simple - prefer simple over clever | Nested ternaries, over-engineered abstractions |
| YAGNI | You Aren't Gonna Need It - don't build for imaginary futures | Adding flexibility for requirements that don't exist |


## Function Design

### Complexity Rules

Single responsibility, one level of abstraction:

    function processOrder(order: Order): ProcessedOrder {
      validateOrder(order);
      const pricing = calculatePricing(order);
      const shipping = determineShipping(order);
      return buildProcessedOrder(order, pricing, shipping);
    }

Avoid god functions doing everything in 200+ lines.

### Function Guidelines

| Rule | Guideline |
|------|-----------|
| Length | Max 20-30 lines |
| Parameters | Max 3-4, use options object for more |
| Nesting | Max 2-3 levels deep |
| Returns | Single return type, predictable behavior |
| Side effects | Minimize and make obvious in function name |

Options object example:

    interface CreateUserOptions {
      name: string;
      email: string;
      role?: UserRole;
      notifyOnCreate?: boolean;
    }
    
    function createUser(options: CreateUserOptions): User { }

### Early Returns

Use guard clauses for flat structure:

    function processPayment(payment: Payment | null): Result {
      if (!payment) return { error: 'No payment provided' };
      if (!payment.isValid) return { error: 'Invalid payment' };
      if (payment.amount <= 0) return { error: 'Invalid amount' };
      
      return executePayment(payment);
    }


## Design Patterns

YAGNI Warning: Only apply patterns when they solve a CURRENT problem.

| Pattern | Use When | Don't Use When |
|---------|----------|----------------|
| Factory | Object creation logic is complex | Simple new Class() suffices |
| Strategy | Multiple algorithms exist NOW | Only one implementation exists |
| Composition | Sharing behavior across components | Inheritance is clearer |

Prefer composition over inheritance:

    const useUserActions = () => {
      const save = () => { };
      const validate = () => { };
      return { save, validate };
    };


## Naming Conventions

### Variables and Functions

| Type | Convention | Examples |
|------|------------|----------|
| Variables | camelCase, descriptive | userList, orderTotal, isAuthenticated |
| Functions | camelCase, verb + noun | getUser, calculateTotal, validateInput |
| Booleans | is/has/can/should prefix | isLoading, hasPermission, canEdit |
| Event handlers | handle + Subject + Action | handleUserClick, handleFormSubmit |
| Async functions | action verb | fetchUsers, createOrder, deleteItem |
| Constants | SCREAMING_SNAKE_CASE | MAX_RETRY_COUNT, API_BASE_URL |

### Files and Directories

| Type | Convention | Examples |
|------|------------|----------|
| Component files | PascalCase | UserProfile.tsx |
| Utility files | camelCase | formatDate.ts |
| Hook files | camelCase with use prefix | useAuth.ts |
| Type files | PascalCase.types.ts | UserProfile.types.ts |
| Test files | name.test.tsx | UserProfile.test.tsx |


## Directory Structure (SRP)

    src/
    ├── components/
    │   ├── common/
    │   │   └── Button/
    │   │       ├── index.ts
    │   │       ├── Button.tsx
    │   │       ├── Button.types.ts
    │   │       ├── Button.styles.ts
    │   │       └── Button.test.tsx
    │   └── features/
    │
    ├── hooks/
    │   ├── useAuth.ts
    │   └── useLocalStorage.ts
    │
    ├── services/
    │   ├── api.ts
    │   └── userService.ts
    │
    ├── utils/
    │   ├── formatters.ts
    │   └── validators.ts
    │
    ├── types/
    │   └── index.ts
    │
    └── constants/
        └── index.ts


## DRY - Don't Repeat Yourself

Extract shared logic:

    const isValidEmail = (email: string): boolean => {
      return Boolean(email && email.includes('@'));
    };
    
    function validateUser(user: User) {
      return isValidEmail(user.email);
    }

Rule of Three: Abstract on the THIRD occurrence, not the first.

| DO Extract | DON'T Extract |
|------------|---------------|
| Identical business logic | Coincidentally similar code |
| Shared validation rules | Code that might diverge |
| Common UI patterns | Premature abstractions |


## YAGNI Checklist

Before adding abstraction, ask:

- Is this solving a CURRENT problem?
- Do I have more than one use case RIGHT NOW?
- Can I add this later without major refactoring?

If no to the first two, don't build it.


## TypeScript Standards

    // Explicit types for functions
    function getUser(id: string): User | null { }
    
    // Use unknown instead of any
    function parseInput(data: unknown): Result { }
    
    // Type imports
    import type { User } from './types';
    
    // Interface for extendable objects
    interface User {
      id: string;
      name: string;
    }
    
    // Type for unions
    type Status = 'idle' | 'loading' | 'success' | 'error';


## Error Handling

    // Specific error handling
    try {
      await fetchData();
    } catch (error) {
      if (error instanceof ApiError) {
        handleApiError(error);
        return;
      }
      throw error;
    }
    
    // Result pattern for expected failures
    type Result<T> = { ok: true; data: T } | { ok: false; error: string };
    
    function validate(input: string): Result<ValidData> {
      if (!input) return { ok: false, error: 'Required' };
      return { ok: true, data: parseData(input) };
    }


## Testing Standards

    describe('UserService', () => {
      describe('getUser', () => {
        it('should return user when id exists', () => { });
        it('should return null when id not found', () => { });
        it('should throw when id format is invalid', () => { });
      });
    });

Guidelines:
- Test behavior, not implementation
- One assertion focus per test
- Naming: should [behavior] when [condition]
- Use Arrange-Act-Assert structure


## Code Documentation

    // Comment WHY, not WHAT
    // Retry 3x due to intermittent third-party API failures
    const MAX_RETRIES = 3;
    
    // JSDoc for public APIs
    /**
     * Fetches user by ID from the database.
     * @param id - Unique user identifier
     * @returns User object or null if not found
     * @throws {ValidationError} When id format is invalid
     */
    function getUser(id: string): User | null { }


## Quick Review Checklist

- [ ] Functions under 30 lines
- [ ] Max 3 levels of nesting
- [ ] No any types
- [ ] No console.log in production
- [ ] Error cases handled
- [ ] Tests written for new code
- [ ] No duplicated logic
- [ ] Clear naming
- [ ] Single responsibility per file