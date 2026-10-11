---
"@actor-kit/worker": minor
"@actor-kit/test": minor
---

Published events carry `position` (ADR-019 E): each actor's published events numbered 1, 2, 3... with no gaps, assigned in the commit transaction and never reused or rewound (a restore keeps counting up). `simulate()` assigns the same positions.
