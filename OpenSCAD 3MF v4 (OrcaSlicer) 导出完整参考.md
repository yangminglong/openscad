# OpenSCAD 3MF v4 (OrcaSlicer) 导出完整参考

## 命令

```bash
openscad input.scad -o output.3mf --export-format 3mf_v4 [-O options...]
```

## `-O` 参数一览

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `export-3mf/filament-colors` | string | `""` (自动检测) | 耗材配置，格式见下 |
| `export-3mf/color-mode` | enum | `model` | `model` / `none` / `selected-only` |
| `export-3mf/unit` | enum | `millimeter` | `micron` / `millimeter` / `centimeter` / `meter` / `inch` / `foot` |
| `export-3mf/color` | string | `#f9d72c` | 默认颜色 |
| `export-3mf/material-type` | enum | `basematerial` | `color` / `basematerial` |
| `export-3mf/decimal-precision` | int | `6` | 小数精度 (1-16) |
| `export-3mf/add-meta-data` | bool | `true` | 是否嵌入元数据 |
| `export-3mf/meta-data-title` | string | `""` | 作品标题 |
| `export-3mf/meta-data-designer` | string | `""` | 设计师 |
| `export-3mf/meta-data-description` | string | `""` | 描述 |
| `export-3mf/meta-data-copyright` | string | `""` | 版权信息 |
| `export-3mf/meta-data-license-terms` | string | `""` | 许可条款 |
| `export-3mf/meta-data-rating` | string | `""` | 评级 |

## `filament-colors` 格式

```
语法: <name>|<serialize>\n<name>|<serialize>...
```

| 颜色类型 | serialize 格式 |
|---|---|
| 纯色 | `#RRGGBBAA` |
| 渐变 | `gradient:#C1,#C2[,C3...];angle:N` |
| 夜光 | `glow:#C1,#C2` |

## 使用示例

```bash
# ===== 最简单的用法：自动检测模型颜色 =====
openscad model.scad -o out.3mf --export-format 3mf_v4

# ===== 单挤出机 =====
openscad model.scad -o out.3mf --export-format 3mf_v4 \
  -O 'export-3mf/filament-colors=PLA|#FF0000FF'

# ===== 多挤出机 =====
openscad model.scad -o out.3mf --export-format 3mf_v4 \
  -O 'export-3mf/filament-colors=PLA|#FF0000FF\nPETG|#0066FFFF\nTPU|#FF00FFFF'

# ===== 渐变耗材 =====
openscad model.scad -o out.3mf --export-format 3mf_v4 \
  -O 'export-3mf/filament-colors=PLA Gradient|gradient:#FF0000FF,#00FF00FF,#0000FFFF;angle:90'

# ===== 夜光耗材 =====
openscad model.scad -o out.3mf --export-format 3mf_v4 \
  -O 'export-3mf/filament-colors=PLA Glow|glow:#FFFF00FF,#0000FFFF'

# ===== 完整：自定义耗材 + 元数据 =====
openscad model.scad -o out.3mf --export-format 3mf_v4 \
  -O 'export-3mf/filament-colors=PLA+|#FF2244FF\nPETG-CF|#444444FF' \
  -O export-3mf/meta-data-title="Gear v2" \
  -O export-3mf/meta-data-designer="hanson" \
  -O export-3mf/meta-data-description="42T planetary gear" \
  -O export-3mf/decimal-precision=9
```

## 输出文件结构

```
output.3mf (ZIP)
├── [Content_Types].xml
├── _rels/.rels
├── 3D/
│   ├── 3dmodel.model          ← 主模型 + 元数据 + 组件引用
│   ├── _rels/3dmodel.model.rels
│   └── Objects/
│       └── <ModelName>_1.model  ← 网格数据 + mmu_segmentation
└── Metadata/
    ├── project_settings.config  ← ~33KB OrcaSlicer 配置
    └── slice_info.config        ← 切片信息模板
```

## 模糊匹配映射

| 输入简称 | 匹配结果 |
|---|---|
| `PLA` | `Anycubic PLA @Anycubic Kobra X 0.4 nozzle` |
| `PETG` | `Anycubic PETG @Anycubic Kobra X 0.4 nozzle` |
| `ABS` | `Anycubic ABS @Anycubic Kobra X 0.4 nozzle` |
| `TPU` | `Anycubic TPU @Anycubic Kobra X 0.4 nozzle` |
| `PLA+` | `Anycubic PLA+ @Anycubic Kobra X 0.4 nozzle` |
| `PA6-CF` | `Anycubic PA6-CF @Anycubic Kobra X 0.4 nozzle` |

匹配策略：优先匹配含 `Anycubic Kobra X` 和 `0.4 nozzle` 的候选，按 token 重合数打分，无匹配回退到 `Anycubic PLA @...`。

## 架构

```
CLI --export-format 3mf_v4
  → export_3mf_v4_from_geometry()    [export_3mf_v4.cc]
    → export_binary_mesh_to_static_buffer()  [binary_mesh_export.cc]
    → autoDetectFilamentColors()     [export_3mf_v4.cc]
    → export_3mf_v4()                [export_3mf_v4.cc]
      → parseBinaryMesh()
      → fuzzyMatchFilamentId()       ← 耗材名 → filament_settings_id
      → buildObjectModelXML()        ← 3D/Objects/<name>_1.model
      → buildMainModelXML()          ← 3D/3dmodel.model
      → buildProjectSettingsConfig() ← Metadata/project_settings.config
      → addStringToZip() × 7         ← libzip 打包
```

### 涉及文件

| 文件 | 职责 |
|---|---|
| `src/io/export_3mf_v4.cc` | 核心导出逻辑、模糊匹配、自动检测 |
| `src/io/export.h` | `FileFormat::_3MF_V4`、`FilamentColor` 类型、`parseFilamentInfos` |
| `src/io/3mf_templates.h` | 内嵌 `PROJECT_SETTINGS_TEMPLATE` + `SLICE_INFO_CONFIG` |
| `src/io/export.cc` | 格式注册 + 分发 |
| `src/wasm/binary_mesh_export.cc` | Geometry → 二进制网格 buffer |
| `src/core/Settings.h` / `Settings.cc` | `export3mfFilamentColors` 设置项 |
| `examples/web/index.html` | Web 耗材配置 UI |
| `examples/web/resources/filaments.json` | Web 耗材数据库 |
