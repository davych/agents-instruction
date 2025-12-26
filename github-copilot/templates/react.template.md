---
id: react-template
title: React Development Standards
category: template
purpose: React expertise standards - component structure, Hooks conventions, performance patterns, naming conventions
---

# React Development Standards

## Core Principles

| Principle | Description | Violation Example |
|-----------|-------------|-------------------|
| Composition | Build complex UI from simple components | One component handling form, validation, submission, display |
| Unidirectional Data | Data flows down, events flow up | Child directly modifying parent state |
| Single Responsibility | Each component does ONE thing well | A component that fetches, processes, and renders data |
| Declarative UI | Describe WHAT to render, not HOW | Imperative DOM manipulation inside components |


## Component Design

### Component Types

| Type | Purpose | Example |
|------|---------|---------|
| Presentational | Pure UI, receives props, no business logic | Button, Card, Avatar |
| Container | Data fetching, state management | UserListContainer |
| Layout | Page structure, composition | PageLayout, Sidebar |
| Feature | Complete feature unit | UserProfile, OrderCheckout |

### Component Size Guidelines

| Rule | Guideline |
|------|-----------|
| Lines | Max 150-200 lines per component |
| JSX depth | Max 4-5 levels of nesting |
| Props | Max 5-7 props, use composition for more |
| Responsibilities | One primary purpose per component |

### When to Split Components

Split when:
- Component exceeds 200 lines
- JSX nesting exceeds 4 levels
- Multiple unrelated state pieces
- Reusable UI pattern identified
- Different update frequencies in same component


## File Structure

### Component Directory

    ComponentName/
    ├── index.ts                    # Public exports
    ├── ComponentName.tsx           # Main component
    ├── ComponentName.types.ts      # TypeScript types
    ├── ComponentName.styles.ts     # Styles (or .module.css)
    ├── ComponentName.test.tsx      # Tests
    ├── ComponentName.utils.ts      # Component-specific utils (if needed)
    └── components/                 # Sub-components (if needed)
        └── ChildComponent.tsx

### Project Structure

    src/
    ├── components/
    │   ├── common/                 # Shared UI components
    │   │   ├── Button/
    │   │   ├── Input/
    │   │   ├── Modal/
    │   │   └── index.ts            # Barrel export
    │   │
    │   ├── layout/                 # Layout components
    │   │   ├── Header/
    │   │   ├── Sidebar/
    │   │   └── PageLayout/
    │   │
    │   └── features/               # Feature components
    │       ├── UserProfile/
    │       └── OrderList/
    │
    ├── hooks/                      # Custom hooks
    │   ├── useAuth.ts
    │   ├── useForm.ts
    │   └── index.ts
    │
    ├── contexts/                   # React contexts
    │   ├── AuthContext.tsx
    │   └── ThemeContext.tsx
    │
    ├── pages/                      # Page components (if not using file-based routing)
    │   ├── HomePage.tsx
    │   └── UserPage.tsx
    │
    ├── services/                   # API services
    ├── utils/                      # Utility functions
    ├── types/                      # Shared types
    └── constants/                  # Constants


## Component Template

### Basic Component

    import React from 'react';
    import type { ComponentNameProps } from './ComponentName.types';
    import styles from './ComponentName.module.css';
    
    export const ComponentName: React.FC<ComponentNameProps> = ({
      title,
      children,
      className,
      ...rest
    }) => {
      // 1. Hooks
      // 2. Derived state
      // 3. Event handlers
      // 4. Early returns (loading, error)
      // 5. Main render
      
      return (
        <div className={styles.container} {...rest}>
          {children}
        </div>
      );
    };

### Types File

    import type { ReactNode, HTMLAttributes } from 'react';
    
    export interface ComponentNameProps extends HTMLAttributes<HTMLDivElement> {
      /** Brief description */
      title: string;
      /** Optional prop */
      subtitle?: string;
      /** Children elements */
      children?: ReactNode;
    }

### Index File

    export { ComponentName } from './ComponentName';
    export type { ComponentNameProps } from './ComponentName.types';


## Naming Conventions

### Components and Files

| Type | Convention | Example |
|------|------------|---------|
| Component name | PascalCase | UserProfile |
| Component file | PascalCase.tsx | UserProfile.tsx |
| Types file | PascalCase.types.ts | UserProfile.types.ts |
| Styles file | PascalCase.module.css | UserProfile.module.css |
| Test file | PascalCase.test.tsx | UserProfile.test.tsx |
| Hook file | camelCase with use | useUserData.ts |
| Context file | PascalCase with Context | AuthContext.tsx |

### Props and Handlers

| Type | Convention | Example |
|------|------------|---------|
| Boolean props | is/has/can/should | isDisabled, hasError, canEdit |
| Handler props | on + Event | onClick, onSubmit, onChange |
| Handler functions | handle + Subject + Event | handleButtonClick, handleFormSubmit |
| Render props | render + Subject | renderItem, renderHeader |
| Children variants | children or specific name | children, headerContent, footerContent |


## Hooks

### Rules

1. Only call at top level (not in conditions/loops)
2. Only call from React functions
3. Custom hooks must start with "use"
4. Return consistent shape (object for multiple values)

### Built-in Hooks Usage

| Hook | Use When |
|------|----------|
| useState | Simple local state |
| useReducer | Complex state logic, multiple sub-values |
| useEffect | Side effects, subscriptions, data fetching |
| useRef | DOM references, mutable values without re-render |
| useMemo | Expensive calculations |
| useCallback | Stable function references for child components |
| useContext | Consuming context values |

### Custom Hook Template

    import { useState, useEffect, useCallback } from 'react';
    
    interface UseHookNameOptions {
      initialValue?: string;
      onSuccess?: (data: unknown) => void;
    }
    
    interface UseHookNameReturn {
      data: unknown;
      isLoading: boolean;
      error: Error | null;
      refetch: () => void;
    }
    
    export const useHookName = (
      options: UseHookNameOptions = {}
    ): UseHookNameReturn => {
      const { initialValue, onSuccess } = options;
      
      const [data, setData] = useState<unknown>(null);
      const [isLoading, setIsLoading] = useState(false);
      const [error, setError] = useState<Error | null>(null);
    
      const refetch = useCallback(() => {
        // Implementation
      }, []);
    
      useEffect(() => {
        // Effect logic
      }, []);
    
      return { data, isLoading, error, refetch };
    };

### Hook Organization in Components

    const MyComponent = () => {
      // 1. Context hooks
      const { user } = useAuth();
      const theme = useTheme();
      
      // 2. State hooks
      const [isOpen, setIsOpen] = useState(false);
      const [formData, setFormData] = useState(initialData);
      
      // 3. Refs
      const inputRef = useRef<HTMLInputElement>(null);
      
      // 4. Custom hooks
      const { data, isLoading } = useUserData(user.id);
      
      // 5. Derived state / memos
      const sortedData = useMemo(() => sortData(data), [data]);
      
      // 6. Callbacks
      const handleSubmit = useCallback(() => {}, []);
      
      // 7. Effects
      useEffect(() => {}, []);
      
      // 8. Early returns
      if (isLoading) return <Loading />;
      
      // 9. Main render
      return <div>...</div>;
    };


## State Management

### Local vs Global State

| State Type | Location | Examples |
|------------|----------|----------|
| UI state | Local useState | isOpen, isHovered, inputValue |
| Component data | Local useState/useReducer | formData, selectedItems |
| Shared UI state | Context | theme, locale, toasts |
| Server state | React Query/SWR | user data, lists, cached data |
| Global app state | Context/Zustand/Redux | auth, cart, app settings |

### useState Patterns

    // Simple state
    const [count, setCount] = useState(0);
    
    // Object state - always spread
    const [form, setForm] = useState({ name: '', email: '' });
    const updateField = (field: string, value: string) => {
      setForm(prev => ({ ...prev, [field]: value }));
    };
    
    // Lazy initialization for expensive initial values
    const [data, setData] = useState(() => computeExpensiveValue());

### useReducer for Complex State

    type State = { count: number; step: number };
    type Action = 
      | { type: 'increment' }
      | { type: 'decrement' }
      | { type: 'setStep'; payload: number };
    
    const reducer = (state: State, action: Action): State => {
      switch (action.type) {
        case 'increment':
          return { ...state, count: state.count + state.step };
        case 'decrement':
          return { ...state, count: state.count - state.step };
        case 'setStep':
          return { ...state, step: action.payload };
        default:
          return state;
      }
    };

### Context Pattern

    interface AuthContextType {
      user: User | null;
      login: (credentials: Credentials) => Promise<void>;
      logout: () => void;
    }
    
    const AuthContext = createContext<AuthContextType | null>(null);
    
    export const useAuth = () => {
      const context = useContext(AuthContext);
      if (!context) {
        throw new Error('useAuth must be used within AuthProvider');
      }
      return context;
    };
    
    export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
      const [user, setUser] = useState<User | null>(null);
      
      const login = async (credentials: Credentials) => { };
      const logout = () => { };
      
      return (
        <AuthContext.Provider value={{ user, login, logout }}>
          {children}
        </AuthContext.Provider>
      );
    };


## Performance

### Memoization Guidelines

| Tool | Use When | Don't Use When |
|------|----------|----------------|
| useMemo | Expensive calculations | Simple computations |
| useCallback | Passing callbacks to memoized children | Handlers for native elements |
| React.memo | Component re-renders often with same props | Props change every render |

### useMemo

    // Expensive computation
    const sortedItems = useMemo(() => {
      return items.sort((a, b) => a.name.localeCompare(b.name));
    }, [items]);
    
    // Complex object creation
    const config = useMemo(() => ({
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000,
    }), [token]);

### useCallback

    // Callback passed to memoized child
    const handleClick = useCallback((id: string) => {
      setSelectedId(id);
    }, []);
    
    // With dependencies
    const handleSubmit = useCallback(() => {
      submitForm(formData);
    }, [formData]);

### React.memo

    // Memoize component
    const ExpensiveList = React.memo(({ items }: Props) => {
      return items.map(item => <Item key={item.id} {...item} />);
    });
    
    // Custom comparison
    const MemoizedComponent = React.memo(Component, (prevProps, nextProps) => {
      return prevProps.id === nextProps.id;
    });

### Lazy Loading

    import { lazy, Suspense } from 'react';
    
    const HeavyComponent = lazy(() => import('./HeavyComponent'));
    
    const App = () => (
      <Suspense fallback={<Loading />}>
        <HeavyComponent />
      </Suspense>
    );


## Conditional Rendering

### Preferred Patterns

    // Boolean condition
    {isVisible && <Component />}
    
    // Binary choice
    {isLoading ? <Spinner /> : <Content />}
    
    // Multiple conditions - extract or use early return
    {status === 'loading' && <Loading />}
    {status === 'error' && <Error />}
    {status === 'success' && <Content />}

### Avoid

    // Nested ternaries
    {a ? (b ? <A /> : <B />) : (c ? <C /> : <D />)}  // Bad
    
    // Complex inline logic
    {items.filter(x => x.active).map(x => <Item />)}  // Extract to variable

### Better Pattern

    const MyComponent = () => {
      // Early returns for states
      if (isLoading) return <Loading />;
      if (error) return <Error error={error} />;
      if (!data) return <Empty />;
      
      // Main render for success state
      return <Content data={data} />;
    };


## Event Handling

### Type-safe Handlers

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setValue(e.target.value);
    };
    
    const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      // Submit logic
    };
    
    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      // Click logic
    };

### Passing Data with Handlers

    // Inline arrow function (ok for simple cases)
    <button onClick={() => handleDelete(item.id)}>Delete</button>
    
    // Data attribute (avoids new function per render)
    <button data-id={item.id} onClick={handleDelete}>Delete</button>
    
    const handleDelete = (e: React.MouseEvent