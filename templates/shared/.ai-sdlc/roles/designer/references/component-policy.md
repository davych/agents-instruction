# Component selection and fallback

Choose the narrowest sustainable option in this order:

1. Reuse the same local product pattern when it has the same semantics.
2. Use a component verified by the project's component catalog.
3. Compose verified primitives without hiding their standard behavior.
4. Create a feature-local component using verified project tokens and primitives.
5. Propose a shared component only when repeated cross-product need is proven.

Before falling back, query the exact name and a semantic term, then inspect nearby source usage. Do not force a visually similar component into the wrong interaction model.

For a custom component record:

- `source: "custom"`
- a semantic `name`
- `scope: "feature"`, `"project"`, or `"shared"`
- a concise `reason`
- `built_from` when verified primitives exist
- only the props and states the product actually needs

A custom component is valid work, but it must not masquerade as an installed export or invent component APIs and tokens.
