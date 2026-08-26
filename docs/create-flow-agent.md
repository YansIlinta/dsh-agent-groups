# Create Flow Agent

**在持久 Multi-Agent Runtime 上构建的视频生产 Flow Agent。**

Create Flow Agent 是 `create-flow-agent` 分支正在扩展的内容生产方向。它不是把多个 Agent 串成一条固定流水线，也不是在 Agent Groups 之外再做一套 workflow engine；它复用 DSH Agent Groups 已有的长期 Member、持久 Session、Task DAG、队列、并行执行与工作区能力，在其上加入视频生产所需要的领域状态和确定性媒体执行。

目标是让一次视频制作从“调用几个一次性 Agent”变成一个可以持续工作的生产团队：Leader 根据当前生产状态拆解任务，按需物化 Specialist；已经启动的 Specialist 在各自长期会话中持续或并行推进。新的研究结果可以产生新的素材任务，素材限制也可以反向触发补充研究，而已经形成的脚本、场景、声音、字幕和渲染结果继续留在同一个生产工作区中。

## 当前能力

Create Flow 直接建立在 Agent Groups 的通用编排能力之上：

- **按需物化的持久生产成员**：Topic Strategist、Researcher、Material Producer、Scriptwriter、Video Producer 先作为可用 role pool 存在，而不是建组时全部启动。Leader 在任务真正需要时按角色 materialize；一旦启动，Member 持有长期 provider session，后续相关工作可以继续复用同一个上下文。
- **空组起步、动态扩展**：Create Flow 建组时不预创建五个 Specialist Session。Topic、Research、Materials 等工作出现后，Leader 才根据当前 workfront 决定启动哪些角色、启动几个实例。
- **任务级动态编排**：Leader 可以创建 Workstream 和 Task，为任务声明 acceptance criteria、能力要求、write scope 与 `blockedBy` 依赖；独立工作可以并行，同一 Specialist 也可以排队接收后续任务。
- **按需扩展团队**：团队角色和 runtime/model 配置由 Agent Groups 管理。Leader 可以复用已有成员，也可以在真正独立的工作需要并行时按角色增加实例，而不需要把所有 Agent 在启动时一次性创建出来。
- **Production DAG**：Create Flow 用生产依赖描述 Topic、Research、Materials、Script、Scenes、Voice/Captions、Render 等阶段，但不把阶段顺序当成 Agent 的固定执行顺序。
- **并行 Ready Stages**：Topic 建立后，Research 与 Materials 可以同时进入 ready；Script 等真正依赖的研究与素材形成后再推进。`workflow.readyStages` 与 `recommendedActions` 会同时暴露当前可推进的方向。
- **生产 Artifact 投影**：Agent Groups 中的任务结果可以投影为 topic、source、material、script、audio、captions、video 等 Create Flow artifact，使 Agent 工作结果进入统一生产视图。
- **Scene Timeline**：脚本和素材可以被组织成有序 Scene；每个 Scene 绑定 visual、narration、audio、subtitle 与 duration，并可在 DSH 原生工作区中新增、修改、删除和重新排序。
- **本地媒体 Runtime**：TTS、ASR、单镜头 Render 与多 Scene Timeline Render 通过 typed production intent 调用本地媒体 runtime；FFmpeg 命令构造保留在确定性执行层，而不是让模型自由拼接 shell command。
- **DSH 原生工作区**：Create Flow 继续运行在原本的 DSH shell 中，使用现有 UI primitive 和 design token，不引入 iframe、第二套路由或独立应用壳。

## 编排模型

Create Flow 把“生产结构”和“Agent 工作结构”分成两层。

### 1. Production Graph

生产层表达的是视频制作中真实存在的依赖：

```text
                    ┌── Research ──┐
Topic ──────────────┤              ├── Script ── Scenes ── Voice / Captions ── Render
                    └── Materials ─┘
```

它回答：**当前已经拥有哪些生产事实？哪些生产动作现在可以开始？**

Research 和 Materials 不需要互相等待；它们只共同依赖 Topic。Script 再消费两条分支产生的内容。后续 Scene、Voice、Caption 和 Render 则沿真实媒体依赖继续推进。

### 2. Agent Task Graph

真正“谁做什么”仍由 Agent Groups Task DAG 表达：

```text
Create Flow Lead
       │
       ├── Research task: factual evidence ───── Researcher A
       ├── Research task: trend scan ────────── Researcher B
       ├── Material task: visual references ─── Material Producer A
       └── Material task: asset preparation ─── Material Producer B
                         │
                         ▼
                    Script tasks
                         │
                         ▼
                    Scene planning
```

一个大的 Research Stage 可以被拆成多个独立 Task；一个新的结果也可以让 Leader 继续创建新的 Task，而不是要求整个 pipeline 从头重跑。

这使 Create Flow 更接近 manager-led orchestration：**Lead 保留全局生产控制权，Specialist 在需要时才被 materialize；已经 materialize 的 Specialist 保留自己的长期上下文，任务图随着工作结果动态展开。**

## Flow Agent 的角色

Create Flow Agent 本身不应该成为第二个 scheduler。

它主要负责三件事：

1. **理解生产状态**：读取当前 artifacts、scenes、media jobs、ready stages 与 Agent Groups task 状态。
2. **决定下一批工作**：根据当前目标和缺失信息，把大阶段拆成可执行 Task，决定哪些工作可以并行、哪些需要依赖边，并据此复用或物化 Specialist。
3. **调用确定性生产动作**：在需要时组织 scene、运行 TTS / ASR / FFmpeg，并把结果继续留在 production workspace 中。

因此整体边界是：

```text
Flow Agent
  = production reasoning
  + dynamic task decomposition
  + specialist allocation
  + typed production actions

Agent Groups
  = role pool + persistent members
  + runtime sessions
  + task DAG / queue / workstreams
  + communication / orchestration

Create Flow State
  = artifacts
  + scenes
  + media jobs
  + production readiness projection

Media Runtime
  = deterministic TTS / ASR / FFmpeg execution

DSH Native Workbench
  = operator view
```

## 正在形成的方向

这个分支的重点不是继续把 `Topic → Research → Materials → Script` 写得越来越死，而是逐渐形成一种更灵活的 Flow Agent：

- **固定的是生产依赖，不固定 Agent 执行顺序。**
- **Stage 可以展开为多个 Task，而不是一阶段只对应一个 Agent。**
- **角色先存在、实例后创建；只有真正出现工作时才占用一个长期 Session。**
- **独立 Specialist 可以并行，相关工作优先复用已经 materialize 的长期 Session。**
- **任务依赖放在 Task DAG，生产依赖放在 Production Graph，两者不要混成第二套状态机。**
- **新信息可以局部触发补充 Research、Materials 或 Scene revision，而不是整条流水线重启。**
- **模型负责生产决策，媒体 runtime 负责确定性执行。**

最终希望形成的不是一个“自动按八个按钮跑完视频”的 pipeline，而是一个能够持续观察生产状态、拆解工作、按需调动长期 Agent 团队并组织真实媒体产物的 **agent-native production workspace**。
