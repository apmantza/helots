- [ ] 1. Create src/core/persona-utils.ts (Target: src/core/persona-utils.ts, Action: CREATE) [DEPENDS: none]

## PHASE 2: ENGINE REFACTORING

- [ ] 2. Remove pickName method from engine.ts (Target: src/core/engine.ts, Symbol: pickName, Action: EDIT) [DEPENDS: 1]
- [ ] 3. Remove getGlobalContext method from engine.ts (Target: src/core/engine.ts, Symbol: getGlobalContext, Action: EDIT) [DEPENDS: 2]
- [ ] 4. Add import statements for persona-utils in engine.ts (Target: src/core/engine.ts, Symbol: import, Action: EDIT) [DEPENDS: 3]

## PHASE 3: EXPORT VERIFICATION

- [ ] 5. Verify public API exports in engine.ts include all necessary references (Target: src/core/engine.ts, Symbol: export, Action: EDIT) [DEPENDS: 4]

## PHASE 4: INTEGRATION VALIDATION

- [ ] 6. Verify usage of pickName throughout engine.ts (Target: src/core/engine.ts, Symbol: pickName, Action: EDIT) [DEPENDS: 5]
- [ ] 7. Verify usage of getGlobalContext throughout engine.ts (Target: src/core/engine.ts, Symbol: getGlobalContext, Action: EDIT) [DEPENDS: 6]

## PHASE 5: FINAL CLEANUP

- [ ] 8. Update engine.ts comment headers if persona-utils referenced (Target: src/core/engine.ts, Symbol: //, Action: EDIT) [DEPENDS: 7]
```

**SPARTAN NOTES:**
- `engine.ts` at 22,798 lines exceeds 400-line threshold → modularization mandatory
- Each edit targets ONE symbol for surgical precision
- Dependencies chained: 1 → 2 → 3 → 4 → 5 → 6 → 7
- Testing/validation tasks removed (Builder constructs, TestRunner validates)