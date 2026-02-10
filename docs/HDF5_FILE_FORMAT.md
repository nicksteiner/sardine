# HDF5 File Format Internals for SAR Product Parsing

**SARdine Technical Reference** — Low-level byte structures, traversal algorithms, and implementation notes for parsing HDF5-based SAR products (NISAR GCOV, ALOS-2, Sentinel-1 CSLC) in pure JavaScript.

> This document describes HDF5 at the wire level: exact byte layouts, magic signatures, bit fields, and the graph traversal needed to go from a superblock to a pixel value. It is the reference for extending `h5chunk.js` to new product types.

---

## Table of Contents

1. [Design Constraints](#1-design-constraints)
2. [File Topology](#2-file-topology)
3. [Superblock](#3-superblock)
4. [Object Headers](#4-object-headers)
5. [Header Messages](#5-header-messages)
6. [Group Structures (v1)](#6-group-structures-v1)
7. [Group Structures (v2)](#7-group-structures-v2)
8. [Data Layout](#8-data-layout)
9. [B-tree v1 — Chunk Index](#9-b-tree-v1--chunk-index)
10. [B-tree v2](#10-b-tree-v2)
11. [Filter Pipeline & Decompression](#11-filter-pipeline--decompression)
12. [Attributes](#12-attributes)
13. [Datatypes](#13-datatypes)
14. [Dataspaces](#14-dataspaces)
15. [Small Dataset Reading](#15-small-dataset-reading)
16. [NISAR GCOV Structural Map](#16-nisar-gcov-structural-map)
17. [Remote Fetching Strategy](#17-remote-fetching-strategy)
18. [Porting to New Products](#18-porting-to-new-products)
19. [Reference Tables](#19-reference-tables)

---

## 1. Design Constraints

h5chunk.js is a streaming HDF5 reader designed for browser environments. Three constraints shape every design decision:

1. **No random access to the full file.** We read an initial metadata buffer (typically 8 MB for NISAR paged-aggregation files) and build as much of the file's structural graph as possible from that window. Anything beyond the buffer requires an explicit range fetch (`File.slice()` or HTTP Range).

2. **No native HDF5 library.** Everything is parsed from raw bytes using `DataView`. There is no libhdf5, no WASM HDF5 binding for the streaming path. This means we must implement every structure the file uses.

3. **Chunk-granular data access.** We never load the full dataset. We build a chunk index (B-tree) and fetch individual chunks on demand for the visible viewport.

The consequence is that h5chunk must understand the full graph from superblock to chunk address, including both v1 and v2 object header formats, both v1 (Symbol Table) and v2 (fractal heap) group enumeration, and multiple data layout versions.

---

## 2. File Topology

An HDF5 file is a directed graph of **objects** (groups and datasets) connected by **links**. The entry point is the **superblock** at byte 0, which points to the **root group object header**. From there, every reachable object is discovered by following links through group structures.

```
Superblock (byte 0)
  │
  └─→ Root Group Object Header
       ├─ Symbol Table msg ─→ B-tree v1 + Local Heap ─→ SNODs ─→ children
       │                                                          (v1 groups)
       └─ Link Info msg ─→ Fractal Heap (FRHP) ─→ Direct Blocks ─→ Link msgs
                                                                     (v2 groups)
```

NISAR GCOV files use **v2 superblocks** (version 2 or 3) and a mix of v1 and v2 group formats. The top-level groups (`/science`, `/metadata`) use v1 Symbol Table structures. Deeper groups like `/science/LSAR/identification` use v2 Link Info with fractal heaps.

---

## 3. Superblock

The superblock is the file's root structure. It starts at byte 0 with the 8-byte HDF5 signature, followed by version-specific fields.

### 3.1 HDF5 Signature

```
Offset   Size   Value
0        8      0x89 0x48 0x44 0x46 0x0d 0x0a 0x1a 0x0a
                (‰HDF\r\n\x1a\n)
```

This signature is designed to detect file corruption and transmission damage, similar to the PNG signature.

### 3.2 Superblock Version 0 / 1

```
Offset   Size   Field
0        8      HDF5 Signature
8        1      Superblock version (0 or 1)
9        1      Free-space storage version
10       1      Root group symbol table version
11       1      Reserved (0)
12       1      Shared header message version
13       1      Size of offsets (bytes) → offsetSize
14       1      Size of lengths (bytes) → lengthSize
15       1      Reserved (0)
16       2      Group leaf node K
18       2      Group internal node K
20       4      File consistency flags
```

Versions 0 and 1 diverge at offset 22:

**Version 1 only:**
```
22       2      Indexed storage internal node K
24       2      Reserved
```

Then both continue:
```
22/26    OS     Base address (usually 0)
+OS      OS     Free-space info address
+OS      OS     End-of-file address
+OS      OS     Driver info block address
+OS      ...    Root group symbol table entry
```

`OS` = offsetSize, `LS` = lengthSize throughout this document.

### 3.3 Superblock Version 2 / 3

NISAR files use this format. It is more compact.

```
Offset   Size   Field
0        8      HDF5 Signature
8        1      Superblock version (2 or 3)
9        1      Size of offsets → offsetSize
10       1      Size of lengths → lengthSize
11       1      File consistency flags
12       OS     Base address
12+OS    OS     Superblock extension address (0xFFFF...F if none)
12+2·OS  OS     End-of-file address
12+3·OS  OS     Root group object header address ← THE ENTRY POINT
12+4·OS  4      Superblock checksum (CRC-32C)
```

**Critical fields:**
- `offsetSize` (typically 8): Determines byte width of all file-offset fields everywhere.
- `lengthSize` (typically 8): Determines byte width of all size fields.
- `rootGroupAddress`: The starting point for all structural traversal.

### 3.4 Implementation Note

h5chunk reads offsetSize and lengthSize first, then uses `reader.readOffset(offsetSize)` and `reader.readLength(lengthSize)` throughout. A typical NISAR file has offsetSize=8 and lengthSize=8, making every address and length field 8 bytes.

---

## 4. Object Headers

Every HDF5 object (group or dataset) begins with an **object header** that contains a sequence of **header messages**. There are two formats: v1 (no signature) and v2 (OHDR signature).

### 4.1 Version 1 Object Header

No magic signature. Identified by context (the address comes from a Symbol Table entry or link).

```
Offset   Size   Field
0        1      Version (must be 1)
1        1      Reserved
2        2      Total number of header messages
4        4      Object reference count
8        4      Header data size (bytes of message space)
12       4      Padding (to 8-byte boundary)
16+      ...    Messages (8-byte aligned)
```

Messages in v1 headers are always padded to 8-byte boundaries. Each message has this prefix:

```
Offset   Size   Field
0        2      Message type (see §5)
2        2      Message data size (bytes, not including this prefix)
4        1      Message flags
5        3      Reserved
8        ...    Message data (size bytes)
```

Total message size = 8 (prefix) + data size, then padded to the next 8-byte boundary.

### 4.2 Version 2 Object Header (OHDR)

Identified by the `OHDR` signature. Used in newer files and by NISAR.

```
Offset   Size   Field
0        4      Signature "OHDR" (0x4F 0x48 0x44 0x52)
4        1      Version (2)
5        1      Flags
```

**Flags byte (critical — this was a source of a major parsing bug):**

| Bit | Meaning |
|-----|---------|
| 0–1 | Chunk 0 size field width: `1 << (flags & 0x03)` bytes (1, 2, 4, or 8) |
| 2 | Attribute creation order tracked |
| 3 | Attribute creation order indexed |
| 4 | Non-default attribute phase change values stored |
| **5** | **Timestamps present (access, modification, change, birth)** |

> **Bug note:** The HDF5 spec (§III.C) defines bit 5 for timestamps and bit 4 for attribute storage phase change values. An earlier implementation incorrectly checked bit 4 (`flags & 0x10`) for timestamps. The identification group had flags=0x20 (bit 5 set), so the parser skipped zero bytes for timestamps and read timestamp data as message content — producing garbage message types. The fix: `flags & 0x20` for timestamps, `flags & 0x10` for phase change values.

After the flags byte:

```
6        (if flags & 0x20) 16 bytes: access, modification, change, birth times (4 bytes each)
...      (if flags & 0x10) 4 bytes: max compact attrs (2) + min dense attrs (2)
...      1/2/4/8  Chunk 0 data size (width from flags bits 0-1)
...      ...      Messages (NOT padded to 8 bytes — packed tightly)
```

v2 message prefix:

```
Offset   Size   Field
0        1      Message type
1        2      Message data size
3        1      Message flags
4        (if header flags & 0x04) 2 bytes: creation order
...      ...    Message data
```

v2 messages are 4 bytes (or 6 with creation order) plus data, with no alignment padding. This is more compact than v1 but means you must track byte positions precisely.

### 4.3 Traversal Pattern

```
parse object header at address A
  → get list of messages [{type, size, offset}, ...]
  → for each message:
       MSG_SYMBOL_TABLE → extract B-tree + heap addresses → enumerate v1 group
       MSG_LINK_INFO    → extract fractal heap address → enumerate v2 group
       MSG_LINK         → hard link with name + child address
       MSG_DATASPACE    → array dimensions
       MSG_DATATYPE     → element type
       MSG_DATA_LAYOUT  → data location (compact/contiguous/chunked)
       MSG_FILTER_PIPELINE → compression chain
       MSG_ATTRIBUTE    → metadata key-value pair
       MSG_OBJ_HEADER_CONTINUATION → follow pointer to more messages
  → if has dataspace + datatype → register as dataset
  → if has group links → recursively parse children
```

---

## 5. Header Messages

### 5.1 Message Type Constants

| Type | Hex | Name | Purpose |
|------|-----|------|---------|
| 0x0001 | MSG_DATASPACE | Dataspace | Array rank and dimensions |
| 0x0002 | MSG_LINK_INFO | Link Info | v2 group: fractal heap + B-tree v2 addresses |
| 0x0003 | MSG_DATATYPE | Datatype | Element type (float32, string, etc.) |
| 0x0005 | MSG_FILL_VALUE | Fill Value | Default fill value for unwritten chunks |
| 0x0006 | MSG_LINK | Link | Hard link to child object (v2 groups) |
| 0x0008 | MSG_DATA_LAYOUT | Data Layout | Where and how data is stored |
| 0x000A | MSG_GROUP_INFO | Group Info | Group-level metadata (estimated entries, etc.) |
| 0x000B | MSG_FILTER_PIPELINE | Filter Pipeline | Compression chain (deflate, shuffle, etc.) |
| 0x000C | MSG_ATTRIBUTE | Attribute | Metadata key-value pair |
| 0x0010 | MSG_OBJ_HEADER_CONTINUATION | Continuation | Pointer to additional messages |
| 0x0011 | MSG_SYMBOL_TABLE | Symbol Table | v1 group: B-tree + local heap addresses |

### 5.2 Object Header Continuation (0x0010)

When a v1 object header's allocated message space is too small, it chains to a **continuation block** elsewhere in the file.

```
Offset   Size   Field
0        OS     Continuation block file offset
OS       LS     Continuation block size (bytes)
```

The continuation block contains messages in the same v1 format (8-byte aligned, same prefix) with no additional header. You parse it identically to the main header's message region.

This is critical for NISAR files where groups have many children: the Symbol Table message often lives in a continuation block beyond the primary header allocation.

---

## 6. Group Structures (v1)

v1 groups use a **Symbol Table** message (type 0x0011) that points to a B-tree v1 and a local heap. The B-tree's leaf nodes are Symbol Table Nodes (SNODs) that contain the actual child entries.

### 6.1 Symbol Table Message

```
Offset   Size   Field
0        OS     B-tree v1 address (group B-tree root node)
OS       OS     Local heap address (name string storage)
```

### 6.2 Local Heap

The local heap stores variable-length strings (child names). It has a fixed header and a separate data segment.

**Signature:** `HEAP` (4 bytes)

```
Offset   Size   Field
0        4      Signature "HEAP" (0x48 0x45 0x41 0x50)
4        1      Version (0)
5        3      Reserved
8        LS     Data segment size (bytes)
8+LS     LS     Offset to head of free list within data segment
8+2·LS   OS     Data segment address (absolute file offset)
```

The data segment is a contiguous block of null-terminated strings. Symbol Table entries reference names by their byte offset into this segment.

### 6.3 B-tree v1 (Group)

**Signature:** `TREE` (4 bytes)

Group B-trees (node type 0) organize child entries for lookup. Their leaf nodes point to Symbol Table Nodes.

```
Offset   Size   Field
0        4      Signature "TREE"
4        1      Node type (0 = group)
5        1      Node level (0 = leaf, >0 = internal)
6        2      Entries used
8        OS     Left sibling address (0xFFFF...F if none)
8+OS     OS     Right sibling address
8+2·OS   ...    Keys and child pointers (interleaved)
```

For group B-trees, each key is a local-heap offset (used for ordering), and each child pointer is:
- **Level 0 (leaf):** Address of a Symbol Table Node (SNOD)
- **Level > 0 (internal):** Address of another TREE node

### 6.4 Symbol Table Node (SNOD)

**Signature:** `SNOD` (4 bytes)

```
Offset   Size   Field
0        4      Signature "SNOD" (0x53 0x4E 0x4F 0x44)
4        1      Version (1)
5        1      Reserved
6        2      Number of symbols (entries in this node)
8        ...    Symbol Table entries (repeated)
```

Each Symbol Table entry:

```
Offset   Size   Field
0        OS     Link name offset (byte index into local heap data segment)
OS       OS     Object header address (absolute file offset of child)
2·OS     4      Cache type
2·OS+4   4      Reserved
2·OS+8   16     Scratch-pad space (interpretation depends on cache type)
```

**Cache type values:**

| Value | Meaning | Scratch-pad Contents |
|-------|---------|---------------------|
| 0 | No cached data | Unused |
| 1 | Cached group (Symbol Table) | B-tree address (OS bytes) + Local heap address (OS bytes) |
| 2 | Cached symbolic link | Link value offset (4 bytes) |

When `cacheType == 1`, the scratch-pad contains the child group's B-tree and heap addresses, allowing you to skip parsing the child's object header entirely and jump straight to enumerating its children. This is an optimization for deep group hierarchies.

### 6.5 Traversal Algorithm

```
enumerateGroupChildren(btreeAddr, heapAddr):
  1. Parse local heap at heapAddr → get data segment
  2. Walk B-tree starting at btreeAddr:
     a. Read TREE node
     b. If leaf (level 0): follow child pointers to SNODs
     c. If internal: recurse into child TREE nodes
  3. For each SNOD: parse entries → {name, objAddr, cacheType, btreeAddr, heapAddr}
  4. Return flat list of children
```

---

## 7. Group Structures (v2)

v2 groups use a **Link Info** message (type 0x0002) that points to a **fractal heap** containing link messages. This is the format used by NISAR's `/science/LSAR/identification` group and was the most complex structure to implement.

### 7.1 Link Info Message

```
Offset   Size   Field
0        1      Version (0)
1        1      Flags
2        (if flags & 0x01) 8 bytes: maximum creation index
...      OS     Fractal heap address (FRHP) → contains the actual links
...      OS     Name index B-tree v2 address → used for name lookups (we skip this)
...      (if flags & 0x02) OS: Creation order B-tree v2 address
```

The fractal heap address is what we need. The B-tree v2 addresses are for efficient lookup by name or creation order; we don't need them because we enumerate all links by walking the heap directly.

### 7.2 Fractal Heap (FRHP)

The fractal heap is HDF5's general-purpose managed object store. For v2 groups, it stores Link messages (the same format as MSG_LINK = 0x0006).

**Signature:** `FRHP` (4 bytes)

**Header layout (approximately 140 bytes for 8-byte offsets):**

```
Offset   Size   Field
0        4      Signature "FRHP" (0x46 0x52 0x48 0x50)
4        1      Version (0)
5        2      Heap ID length
7        2      I/O filter encoder size (0 if no I/O filters)
9        1      Flags
10       4      Maximum size of managed objects
14       8      Next huge object ID
22       8      v2 B-tree address for huge objects
30       8      Amount of free space in managed blocks
38       8      Address of managed block free-space manager
46       8      Amount of managed space in heap
54       8      Amount of allocated managed space
62       8      Offset of direct block allocation iterator
70       8      Number of managed objects in heap ← managedNobjs
78       8      Size of huge objects in heap
86       8      Number of huge objects
94       8      Size of tiny objects
102      8      Number of tiny objects
110      2      Table width (W) — entries per row in indirect block
112      8      Starting block size (Row 0 direct block size)
120      8      Maximum direct block size
128      2      Max heap size (log2 bits) ← maxHeapSize
130      2      Starting # of rows in root indirect block
132      OS     Root block address ← rootBlockAddr
132+OS   2      Current # of rows in root indirect block ← curNumRows
134+OS   (if I/O filters) compressed root block info
...      4      Checksum
```

**Key fields for traversal:**
- `tableWidth (W)`: Number of entries per row in an indirect block (typically 4)
- `startingBlockSize`: Size of Row 0 direct blocks (e.g., 512 bytes)
- `rootBlockAddr`: Address of the root block
- `curNumRows`: If 0, root is a **direct block**. If >0, root is an **indirect block**.
- `managedNobjs`: Total number of managed objects (links) — used as upper bound for scanning.
- `maxHeapSize`: Used to compute `blockOffsetBytes = ceil(maxHeapSize / 8)`

### 7.3 Direct Block (FHDB)

A direct block contains the actual managed objects (link messages).

**Signature:** `FHDB` (4 bytes)

```
Offset   Size   Field
0        4      Signature "FHDB" (0x46 0x48 0x44 0x42)
4        1      Version (0)
5        OS     Heap header address (back-reference to FRHP)
5+OS     BO     Block offset within heap (BO = blockOffsetBytes)
5+OS+BO  ...    Object data region
```

Where `blockOffsetBytes = ceil(maxHeapSize / 8)`.

After the header, there are typically 4 bytes of padding, then the managed objects are packed sequentially. Each managed object is a complete Link message (see §7.5).

### 7.4 Indirect Block (FHIB)

An indirect block contains pointers to child blocks (direct or other indirect blocks), organized in rows.

**Signature:** `FHIB` (4 bytes)

```
Offset   Size   Field
0        4      Signature "FHIB" (0x46 0x48 0x49 0x42)
4        1      Version (0)
5        OS     Heap header address (back-reference to FRHP)
5+OS     BO     Block offset within heap
5+OS+BO  ...    Child block entries (organized by row)
```

**Row structure:**
- Row 0: `W` entries, each pointing to a direct block of size `startingBlockSize`
- Row 1: `W` entries, each pointing to a direct block of size `startingBlockSize × 2`
- Row 2: `W` entries, each pointing to a direct block of size `startingBlockSize × 4`
- Row K: `W` entries, blocks of size `startingBlockSize × 2^K` (up to maxDirectBlockSize)
- Higher rows: entries point to child indirect blocks (not direct blocks)

Each entry is simply an `OS`-byte file offset. An entry of `0` or `0xFFFF...F` means "unused."

The number of rows to read is `curNumRows` from the FRHP header.

### 7.5 Link Message Format

Each managed object in the fractal heap is a Link message, identical to MSG_LINK (0x0006):

```
Offset   Size   Field
0        1      Version (1)
1        1      Flags
```

**Flags:**
| Bit | Meaning |
|-----|---------|
| 0–1 | Name length encoding size: 0→1 byte, 1→2 bytes, 2→4 bytes, 3→8 bytes |
| 2 | Creation order present |
| 3 | Link type field present (0 = hard link) |
| 4 | Character set field present |

After the flags:

```
(if flags & 0x08) 1 byte:  link type (0 = hard, 1 = soft, 64 = external)
(if flags & 0x04) 8 bytes: creation order
(if flags & 0x10) 1 byte:  character set (0 = ASCII, 1 = UTF-8)
1/2/4/8 bytes:              name length (encoding from flags bits 0-1)
N bytes:                    name (UTF-8, NOT null-terminated)
OS bytes:                   object header address (for hard links)
```

### 7.6 Fractal Heap Traversal Algorithm

```
enumerateV2GroupLinks(fheapAddr):
  1. Fetch FRHP header (256 bytes) at fheapAddr
  2. Parse: tableWidth, startingBlockSize, rootBlockAddr, curNumRows, maxHeapSize
  3. blockOffsetBytes = ceil(maxHeapSize / 8)

  4. IF curNumRows == 0:
       // Root IS a direct block
       directBlocks = [{addr: rootBlockAddr, size: startingBlockSize}]
     ELSE:
       // Root is an indirect block — parse it
       ibHeaderSize = 4 + 1 + OS + blockOffsetBytes
       Fetch indirect block at rootBlockAddr (header + W × curNumRows × OS bytes)
       Verify FHIB signature
       Skip header (ibHeaderSize bytes)
       FOR each row r in [0, curNumRows):
         blockSize = startingBlockSize × 2^r  (capped at maxDirectBlockSize)
         FOR each entry e in [0, W):
           Read OS-byte address
           IF valid → directBlocks.push({addr, size: blockSize})

  5. FOR each direct block:
       Fetch full block at addr
       Verify FHDB signature
       dbHeaderSize = 4 + 1 + OS + blockOffsetBytes
       Start scanning at dbHeaderSize + 4 (padding)
       WHILE offset < blockSize AND results.length < managedNobjs:
         Parse Link message → extract {name, address}
         IF valid → results.push({name, address})

  6. RETURN results
```

### 7.7 Practical Example: NISAR Identification Group

The `/science/LSAR/identification` group in our test file:

- FRHP header at `0x70836630`
- 34 managed objects (all identification fields like productType, trackNumber, etc.)
- Root is an indirect block (curNumRows > 0)
- Indirect block contains 2 direct blocks:
  - Block 0 at `0x70836228` (512 bytes, ~20 link messages)
  - Block 1 at `0x70836028` (512 bytes, ~14 link messages)
- Each link message points to an object header at `~0x70800000` range
- Those object headers contain scalar string/integer datasets (compact or contiguous layout)

---

## 8. Data Layout

The Data Layout message (type 0x0008) tells you where a dataset's actual data lives.

### 8.1 Layout Classes

| Class | Name | Description |
|-------|------|-------------|
| 0 | Compact | Data stored inline in the object header |
| 1 | Contiguous | Single contiguous block at a file address |
| 2 | Chunked | Multiple independently-addressable chunks via B-tree |

### 8.2 Compact Layout (Class 0)

The data is embedded directly in the layout message. Used for very small datasets (scalar metadata fields like productType, trackNumber).

**Version 1-2:**
```
Offset   Size   Field
0        1      Version (1 or 2)
1        1      Rank (dimensionality)
2        1      Layout class (0)
3        5      Reserved
8        2      Compact data size (bytes)
10       ...    Data bytes (inline)
```

**Version 3-4:**
```
Offset   Size   Field
0        1      Version (3 or 4)
1        1      Layout class (0)
2        2      Compact data size
4        ...    Data bytes (inline)
```

### 8.3 Contiguous Layout (Class 1)

Data is stored as a single block at a known file offset. Used for 1D coordinate arrays and small datasets.

**Version 1-2:**
```
Offset   Size   Field
0        1      Version
1        1      Rank
2        1      Layout class (1)
3        5      Reserved
8        OS     Data address (file offset)
8+OS     LS     Data size (bytes)
```

**Version 3-4:**
```
Offset   Size   Field
0        1      Version (3 or 4)
1        1      Layout class (1)
2        OS     Data address
2+OS     LS     Data size
```

### 8.4 Chunked Layout (Class 2)

Data is divided into fixed-size chunks, each stored at its own file address. This is the primary format for NISAR imagery data (e.g., 16704×16272 float32 HHHH backscatter). A B-tree indexes chunk locations.

**Version 3:**
```
Offset   Size   Field
0        1      Version (3)
1        1      Layout class (2)
2        1      Rank (includes an extra "element size" dimension)
3        OS     B-tree v1 address (chunk index root)
3+OS     4×R    Chunk dimensions (4 bytes each)
```

The last dimension in the chunk dimensions array is the element size in bytes (e.g., 4 for float32), not a spatial dimension.

**Version 4:**
```
Offset   Size   Field
0        1      Version (4)
1        1      Layout class (2)
2        1      Flags (bit 0–4 encode chunk indexing method, etc.)
3        1      Dimensionality (rank, without the element-size dimension)
4        1      Dimension index encoding size (bytes per dimension)
5        DS×R   Chunk dimensions
5+DS×R   1      Chunk indexing type (1 = B-tree v1, 2 = B-tree v2, etc.)
6+DS×R   OS     Index address (B-tree root)
```

---

## 9. B-tree v1 — Chunk Index

For chunked datasets, a B-tree v1 (type 1 — "raw data chunks") maps chunk grid coordinates to file offsets. This is the structure h5chunk uses to build its chunk index.

### 9.1 B-tree v1 Node

**Signature:** `TREE` (4 bytes)

```
Offset   Size   Field
0        4      Signature "TREE"
4        1      Node type (1 = raw data chunk)
5        1      Node level (0 = leaf, >0 = internal)
6        2      Entries used (K)
8        OS     Left sibling address
8+OS     OS     Right sibling address
8+2·OS   ...    Keys and child pointers
```

### 9.2 Chunk B-tree Keys

For type-1 B-trees, each key describes a chunk's grid position:

```
Offset   Size   Field
0        4      Chunk size in bytes (after filters, on disk)
4        4      Filter mask (bitmask of skipped filters)
8        8×R    Chunk offsets (R = rank, 8 bytes each)
```

The chunk offsets are in element units. For a 2D dataset with chunk dimensions [256, 256], the offsets for the chunk at grid position (row=512, col=768) would be [512, 768, 0] — the third dimension is the byte offset within the element (usually 0).

### 9.3 Chunk Index Building

```
parseBTreeV1(btreeAddr, rank):
  chunks = new Map()

  function parseNode(addr):
    Read TREE header
    Verify signature, nodeType == 1
    Collect all entries {key, childAddr} into array first (to avoid reader confusion)

    IF level == 0 (leaf):
      FOR each entry:
        key = "offset0,offset1,..."  // spatial dimensions only (drop last)
        chunks.set(key, {
          offset: childAddr,    // file offset of compressed chunk data
          size: entry.chunkSize, // compressed size on disk
          filterMask: entry.filterMask,
          indices: entry.offsets[0..rank-2]
        })

    ELSE (internal, level > 0):
      FOR each childAddr:
        parseNode(childAddr)  // recurse

  parseNode(btreeAddr)
  RETURN chunks
```

The resulting Map looks like:

```javascript
{
  "0,0":     { offset: 0x1234567, size: 65536, filterMask: 0, indices: [0, 0] },
  "0,256":   { offset: 0x1244567, size: 64200, filterMask: 0, indices: [0, 256] },
  "256,0":   { offset: 0x1254567, size: 63800, filterMask: 0, indices: [256, 0] },
  ...
}
```

To read a specific chunk: look up the key, fetch `size` bytes from `offset`, decompress.

---

## 10. B-tree v2

Newer HDF5 files may use B-tree v2 for chunk indexing. The structure is more complex and is identified by signature `BTHD`.

**Header:**
```
Offset   Size   Field
0        4      Signature "BTHD"
4        1      Version
5        1      Type (10 = chunked filtered, 11 = chunked non-filtered)
6        4      Node size
10       2      Record size
12       2      Depth
14       1      Split percent
15       1      Merge percent
16       OS     Root node address
16+OS    2      Number of records in root
18+OS    LS     Total number of records in tree
```

**Leaf nodes** use signature `BTLF`, **internal nodes** use `BTIN`. Record format depends on the type field.

h5chunk has a partial implementation of B-tree v2 parsing. For NISAR GCOV files, the main imagery datasets use B-tree v1, so this has not been a blocking issue. New product types may require completing the v2 implementation.

---

## 11. Filter Pipeline & Decompression

The Filter Pipeline message (type 0x000B) describes the compression chain applied to chunked data.

### 11.1 Filter Pipeline Message

**Version 1:**
```
Offset   Size   Field
0        1      Version (1)
1        1      Number of filters
2        6      Reserved
8        ...    Filter descriptions (repeated)
```

**Version 2:**
```
Offset   Size   Field
0        1      Version (2)
1        1      Number of filters
2        ...    Filter descriptions (no reserved bytes)
```

### 11.2 Filter Description (v1)

```
Offset   Size   Field
0        2      Filter ID
2        2      Name length (0 = no name)
4        2      Flags
6        2      Number of client data values (N)
8        ...    Name (if length > 0, padded to 8-byte boundary)
...      4×N    Client data values (4 bytes each, unsigned)
...      (if N is odd) 4 bytes padding
```

### 11.3 Filter Description (v2)

```
Offset   Size   Field
0        2      Filter ID
2        2      Flags
4        2      Number of client data values (N)
6        4×N    Client data values
```

### 11.4 Common Filter IDs

| ID | Name | Description |
|----|------|-------------|
| 1 | DEFLATE | zlib compression (window bits from client data, or default) |
| 2 | SHUFFLE | Byte-order rearrangement for better compression |
| 3 | FLETCHER32 | Checksum (4-byte CRC appended to chunk) |
| 4 | SZIP | Entropy coding (not implemented in h5chunk) |
| 5 | NBIT | Bit packing |
| 6 | SCALEOFFSET | Linear transform + integer encoding |

### 11.5 Decompression Pipeline

Filters are applied in reverse order during read:

```
readChunk(offset, size):
  1. Fetch compressed bytes from file
  2. Apply filters in REVERSE pipeline order:
     - FLETCHER32: strip last 4 bytes (checksum)
     - DEFLATE:    zlib inflate (pako or DecompressionStream API)
     - SHUFFLE:    unshuffle bytes
  3. Cast to appropriate TypedArray (Float32Array for float32 data)
```

### 11.6 Shuffle Algorithm

The shuffle filter rearranges bytes so that corresponding byte positions across elements are grouped together (improves deflate compression ratio).

**Encoding** (done by writer):
```
Original: [B0₀B1₀B2₀B3₀] [B0₁B1₁B2₁B3₁] [B0₂B1₂B2₂B3₂] ...
Shuffled: [B0₀B0₁B0₂...] [B1₀B1₁B1₂...] [B2₀B2₁B2₂...] [B3₀B3₁B3₂...]
```

**Decoding** (unshuffle, done by reader):
```javascript
function unshuffle(data, elementSize) {
  const count = data.length / elementSize;
  const result = new Uint8Array(data.length);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < elementSize; j++) {
      result[i * elementSize + j] = data[j * count + i];
    }
  }
  return result;
}
```

---

## 12. Attributes

Attribute messages (type 0x000C) store metadata key-value pairs on any object.

### 12.1 Attribute Message (Version 1)

```
Offset   Size   Field
0        1      Version (1)
1        1      Reserved
2        2      Name size (including null terminator)
4        2      Datatype message size
6        2      Dataspace message size
8        ...    Name (padded to 8-byte boundary)
...      ...    Embedded Datatype message
...      ...    Embedded Dataspace message
...      ...    Attribute data (raw bytes)
```

### 12.2 Attribute Message (Version 2-3)

```
Offset   Size   Field
0        1      Version (2 or 3)
1        1      Flags (bit 2 = character encoding field present)
2        2      Name size
4        2      Datatype message size
6        2      Dataspace message size
8        (if flags & 0x04) 1 byte: encoding (0=ASCII, 1=UTF-8)
...      ...    Name (NO padding in v2-3)
...      ...    Embedded Datatype message
...      ...    Embedded Dataspace message
...      ...    Attribute data
```

### 12.3 Data Decoding

The attribute data bytes are interpreted according to the embedded datatype:
- **string**: Read N bytes, decode as UTF-8, strip null terminators
- **float32/float64**: Cast to Float32Array/Float64Array via DataView
- **int/uint**: Cast to appropriate TypedArray
- **Array**: For multi-element attributes, read `prod(dims) × elementSize` bytes

---

## 13. Datatypes

The Datatype message (type 0x0003) describes the binary encoding of data elements.

### 13.1 Datatype Message Layout

```
Offset   Size   Field
0        1      Class and version (lower 4 bits = class, upper 4 bits = version)
1        3      Class-specific bit fields
4        4      Element size (bytes)
8        ...    Class-specific properties
```

### 13.2 Type Classes

| Class | Name | Size(s) | h5chunk dtype |
|-------|------|---------|---------------|
| 0 | Fixed-point (integer) | 1, 2, 4, 8 | uint8/int8, uint16/int16, uint32/int32, uint64/int64 |
| 1 | Floating-point | 2, 4, 8 | float16, float32, float64 |
| 3 | String | variable | string |

### 13.3 Bit Fields

**Byte 1 (bit field 1):**
- Bit 0: Byte order (0 = little-endian, 1 = big-endian) — for classes 0 and 1
- Bit 3: Sign (0 = unsigned, 1 = signed) — for class 0 only

### 13.4 Decoding Matrix

| Class | Endian | Signed | Size | Result |
|-------|--------|--------|------|--------|
| 0 | LE | unsigned | 1 | `uint8` |
| 0 | LE | signed | 1 | `int8` |
| 0 | LE | unsigned | 2 | `uint16` |
| 0 | LE | unsigned | 4 | `uint32` |
| 1 | LE | — | 2 | `float16` |
| 1 | LE | — | 4 | `float32` |
| 1 | LE | — | 8 | `float64` |
| 3 | — | — | N | `string` |

### 13.5 Float16 Decoding

IEEE 754 binary16 is not natively supported by JavaScript. h5chunk decodes it manually:

```
Bit layout: [S:1][E:5][F:10]
  S = sign bit
  E = biased exponent (bias = 15)
  F = fraction (10 bits, implied leading 1 for normals)

Special cases:
  E == 0, F == 0 → ±0.0
  E == 0, F != 0 → subnormal: (-1)^S × 2^(-14) × (F/1024)
  E == 31        → ±Infinity (F==0) or NaN (F!=0)
  Otherwise      → (-1)^S × 2^(E-15) × (1 + F/1024)
```

---

## 14. Dataspaces

The Dataspace message (type 0x0001) describes array rank and dimensions.

### 14.1 Version 1

```
Offset   Size   Field
0        1      Version (1)
1        1      Rank (0 = scalar, 1–32 = array)
2        1      Flags (bit 0: max dimensions present)
3        5      Reserved
8        8×R    Current dimensions (8 bytes each)
(opt)    8×R    Maximum dimensions (if flags & 0x01)
```

### 14.2 Version 2

```
Offset   Size   Field
0        1      Version (2)
1        1      Rank
2        1      Flags (bit 0: max dimensions present)
3        1      Type (0 = scalar, 1 = simple, 2 = null)
4        8×R    Current dimensions
(opt)    8×R    Maximum dimensions
```

### 14.3 Common Shapes in NISAR

| Dataset | Rank | Dimensions | Notes |
|---------|------|-----------|-------|
| HHHH backscatter | 2 | [16704, 16272] | Main imagery |
| latitude | 1 | [16704] | Coordinate array |
| longitude | 1 | [16272] | Coordinate array |
| productType | 0 | [] (scalar) | String metadata |
| trackNumber | 0 | [] (scalar) | Uint32 metadata |

---

## 15. Small Dataset Reading

For metadata fields (identification, coordinates), h5chunk reads entire small datasets without going through the chunk pipeline.

### 15.1 Algorithm

```
readSmallDataset(datasetId):
  ds = datasets.get(datasetId)
  totalBytes = product(ds.shape) × ds.bytesPerElement (or ds.layout.size for compact)

  IF ds.layout.type == 'compact':
    // Data is inline in the object header message
    // The layout's 'address' points to the data offset and '_reader' to the buffer
    Read bytes from the layout's buffer at the stored offset

  ELSE IF ds.layout.type == 'contiguous':
    IF ds.layout.address < metadataBuffer.byteLength:
      Read directly from metadata buffer
    ELSE:
      Fetch via _fetchBytes(address, totalBytes)

  ELSE IF ds.layout.type == 'chunked' AND only 1 chunk:
    Use readChunk() for the single chunk

  Decode bytes according to dtype:
    - string → array of strings (split by nulls)
    - float32/64 → TypedArray
    - uint/int → TypedArray

  RETURN {data, shape, dtype}
```

### 15.2 Compact Layout Nuance

When data is compact, the layout message stores both the data offset (within the object header's buffer) and a reference to the buffer/reader that contains it. For remote objects, this buffer is the 8KB fetch from `_fetchBytes`, not the main metadata buffer.

---

## 16. NISAR GCOV Structural Map

A typical NISAR L2 GCOV file (e.g., 1.9 GB) has this layout:

```
Byte 0: Superblock v2
  offsetSize = 8, lengthSize = 8
  rootGroupAddress ≈ 0x60 (within first page)

Bytes 0–8 MB: Metadata pages (paged aggregation)
  Contains: root group headers, /science, /science/LSAR,
  /science/LSAR/GCOV, frequency/polarization groups,
  coordinate datasets, imagery dataset headers + B-trees

Bytes 8 MB–~1.9 GB: Data pages
  Contains: compressed imagery chunks (deflate + shuffle),
  contiguous coordinate arrays, identification metadata

/
├── science/
│   └── LSAR/
│       ├── identification/                    ← v2 group (fractal heap)
│       │   ├── productType: "GCOV"            ← contiguous string, ~0x708xxxxx
│       │   ├── absoluteOrbitNumber: 2149      ← contiguous uint32
│       │   ├── trackNumber: 147               ← contiguous uint32
│       │   ├── frameNumber: 175               ← contiguous uint16
│       │   ├── lookDirection: "Left"          ← contiguous string
│       │   ├── orbitPassDirection: "Ascending" ← contiguous string
│       │   ├── zeroDopplerStartTime: "2025-12-26T10:44:04..."
│       │   ├── zeroDopplerEndTime: "..."
│       │   └── ... (34 datasets total)
│       │
│       └── GCOV/
│           └── grids/
│               └── frequencyA/               ← v1 group (Symbol Table)
│                   ├── HHHH [16704×16272] float32, chunked [256×256]
│                   │   └── B-tree v1 with ~4000 chunk entries
│                   ├── HVHV [16704×16272] float32, chunked
│                   ├── VVVV [16704×16272] float32, chunked
│                   ├── HVVV [16704×16272] float32, chunked
│                   ├── xCoordinates [16272] float64, contiguous
│                   ├── yCoordinates [16704] float64, contiguous
│                   ├── projection: scalar string (EPSG code)
│                   └── xCoordinateSpacing / yCoordinateSpacing: float64
│
└── metadata/
    └── radarGrid/                             ← metadata cube
        ├── incidenceAngle [nHeight×nY×nX]
        ├── slantRange [nHeight×nY×nX]
        └── ...
```

**Address ranges observed in test file:**
- Metadata buffer: `0x000000` – `0x800000` (~8 MB)
- Identification datasets: `~0x70800000` – `0x70840000` (~256 KB region)
- Imagery chunks: scattered throughout `0x800000` – `0x71500000`

---

## 17. Remote Fetching Strategy

When an address falls outside the metadata buffer, h5chunk uses targeted byte-range fetches.

### 17.0 Local File Serving (On-Demand Server)

When running SARdine on an on-demand server (e.g., SMCE ODS, JupyterHub, cloud VM) accessed through JupyterLab, local HDF5 files can be served to the browser via a lightweight Range-request file server.

**Start the server in a JupyterLab terminal:**

```bash
# Serve files from your home directory
node server/local-file-server.mjs ~

# Serve files from a specific data directory
node server/local-file-server.mjs ~/ods

# Custom port
PORT=9000 node server/local-file-server.mjs ~/ods
```

**Accessing through JupyterLab's proxy:**

Since the browser connects to the ODS through JupyterLab (not directly), `localhost:8081` won't work in the browser. Instead, use JupyterLab's built-in proxy. If your JupyterLab URL looks like:

```
https://ods.example.com/user/nsteiner/lab
```

Then access the file server at:

```
https://ods.example.com/user/nsteiner/proxy/8081/path/to/file.h5
```

Or use `jupyter-server-proxy` if installed:

```
https://ods.example.com/user/nsteiner/proxy/absolute/8081/path/to/file.h5
```

**Alternatively**, avoid the proxy entirely by using the file server from Node.js scripts running in the same terminal (no browser needed):

```bash
# Test with the debug script — reads the file directly, no server needed
node test/debug-h5chunk-datasets.mjs ~/ods/NISAR_L2_GCOV.h5
```

The file server features:
- Lists `.h5` / `.hdf5` / `.he5` / `.nc` files as JSON at directory paths
- Supports HTTP `Range` requests for on-demand chunk fetching
- Adds CORS headers so the SARdine browser app can fetch from it

This is functionally identical to fetching from S3 — h5chunk's `_fetchBytes` issues Range requests against the local server instead of a remote URL.

### 17.1 BufferReader with baseOffset

The `BufferReader` class supports a `baseOffset` parameter that maps absolute file addresses to buffer-relative positions:

```javascript
class BufferReader {
  constructor(buffer, littleEndian = true, baseOffset = 0) {
    this.view = new DataView(buffer);
    this.pos = baseOffset;  // Current position = absolute file address
    this._base = baseOffset;
  }

  // Buffer-relative offset for DataView access
  get _off() { return this.pos - this._base; }

  // Bounds check against actual buffer size
  canRead(n) { return this._off >= 0 && this._off + n <= this.view.byteLength; }

  readUint8() {
    const v = this.view.getUint8(this._off);  // Uses buffer offset, not file offset
    this.pos += 1;  // Advances file position
    return v;
  }

  seek(absoluteAddress) { this.pos = absoluteAddress; }
}
```

This means all the same parsing code works for both local (metadata buffer) and remote buffers — only the reader construction differs:

```javascript
// Local: buffer starts at file byte 0
const localReader = new BufferReader(metadataBuffer, true, 0);

// Remote: buffer contains bytes from address 0x70800000
const remoteBuf = await fetchBytes(0x70800000, 8192);
const remoteReader = new BufferReader(remoteBuf, true, 0x70800000);
remoteReader.seek(0x70800093);  // Seek to an absolute address
// _off = 0x70800093 - 0x70800000 = 0x93 → reads from buffer index 0x93
```

### 17.2 Fetch Sizes

| Purpose | Fetch Size | Rationale |
|---------|-----------|-----------|
| Object header | 8 KB | Covers header + inline messages + continuation pointers |
| FRHP header | 256 bytes | FRHP header is ~140-150 bytes |
| FHIB indirect block | Variable | `ibHeaderSize + W × curNumRows × OS + 32` |
| FHDB direct block | Block size | Full block (e.g., 512 bytes) |
| Local heap header | Header + 16 | `4+1+3 + LS + LS + OS + 16` |
| Heap data segment | Data size | From heap header's data segment size field |
| Small dataset | Data size | `prod(shape) × bytesPerElement`, max 64 KB |
| Continuation block | Block size | From continuation message's length field |

### 17.3 Known Limitations

- **boundingPolygon**: This ~2KB string dataset has an object header + continuation that exceeds the 8KB fetch. A future improvement would dynamically increase the fetch size or follow continuations across multiple fetches.
- **B-trees beyond metadata buffer**: Chunk B-trees for imagery are typically within the 8MB metadata buffer (paged aggregation). If not, the dataset is discovered but chunks can't be indexed without additional fetching.

---

## 18. Porting to New Products

When adding support for a new HDF5-based SAR product (e.g., ALOS-2 PALSAR-2, Sentinel-1 CSLC, ICEYE SLC), the following structural differences may arise:

### 18.1 Checklist

| Feature | NISAR GCOV | May Differ |
|---------|-----------|------------|
| Superblock version | v2 (version 2) | v0/v1 in older files |
| Object header format | Mix of v1 and v2 | May be all v1 or all v2 |
| Group format | Mix of Symbol Table and Link Info | May use only one format |
| Chunk layout version | v3 and v4 | May use v1/v2 layout |
| Chunk index | B-tree v1 | May use B-tree v2 or extensible arrays |
| Filters | Deflate + Shuffle | May use SZIP, NBIT, or no compression |
| Datatype | Float32 | May use Float16, complex (pairs), etc. |
| Coordinate system | EPSG:4326 (lat/lon arrays) | UTM, polar stereographic, etc. |
| Paged aggregation | Yes (metadata in first 8 MB) | May not use paging |

### 18.2 Debugging Approach

1. **Run the debug script** to see what h5chunk discovers:
   ```bash
   node test/debug-h5chunk-datasets.mjs path/to/file.h5
   ```

2. **Compare with h5py** to identify missing datasets:
   ```python
   import h5py
   def visit(name, obj):
       if isinstance(obj, h5py.Dataset):
           print(f"  {name}: shape={obj.shape} dtype={obj.dtype}")
   f = h5py.File('file.h5', 'r')
   f.visititems(visit)
   ```

3. **Use h5dump for structural details:**
   ```bash
   h5dump -H -A file.h5 | head -200  # Headers and attributes only
   ```

4. **Check for unknown message types** — h5chunk logs warnings for unhandled message types. These may need new parsers.

5. **Check for B-tree v2 chunk indexing** — if `parseBTreeV1` fails or returns empty, the dataset may use v2 or extensible array indexing.

### 18.3 Extension Points

To support a new product:

1. **Loader module**: Create `src/loaders/<product>-loader.js` (mirrors `nisar-loader.js`)
2. **Path mapping**: Define HDF5 paths for the product's datasets, coordinates, and metadata
3. **h5chunk extensions**: Add any new message types, filter IDs, or layout versions
4. **Coordinate handling**: Implement CRS extraction and bounds computation for the product's projection

---

## 19. Reference Tables

### 19.1 Magic Signatures

| Signature | Hex | Structure |
|-----------|-----|-----------|
| `‰HDF\r\n\x1a\n` | `89 48 44 46 0D 0A 1A 0A` | HDF5 file (superblock) |
| `OHDR` | `4F 48 44 52` | v2 Object Header |
| `TREE` | `54 52 45 45` | B-tree v1 node |
| `HEAP` | `48 45 41 50` | Local Heap |
| `SNOD` | `53 4E 4F 44` | Symbol Table Node |
| `FRHP` | `46 52 48 50` | Fractal Heap header |
| `FHDB` | `46 48 44 42` | Fractal Heap Direct Block |
| `FHIB` | `46 48 49 42` | Fractal Heap Indirect Block |
| `BTHD` | `42 54 48 44` | B-tree v2 header |
| `BTLF` | `42 54 4C 46` | B-tree v2 leaf node |
| `BTIN` | `42 54 49 4E` | B-tree v2 internal node |

### 19.2 Message Types

| Type | Hex | Name |
|------|-----|------|
| 1 | 0x0001 | Dataspace |
| 2 | 0x0002 | Link Info |
| 3 | 0x0003 | Datatype |
| 5 | 0x0005 | Fill Value |
| 6 | 0x0006 | Link |
| 8 | 0x0008 | Data Layout |
| 10 | 0x000A | Group Info |
| 11 | 0x000B | Filter Pipeline |
| 12 | 0x000C | Attribute |
| 16 | 0x0010 | Object Header Continuation |
| 17 | 0x0011 | Symbol Table |

### 19.3 Filter IDs

| ID | Name | Parameters |
|----|------|-----------|
| 1 | DEFLATE | Level (0-9) |
| 2 | SHUFFLE | Element size |
| 3 | FLETCHER32 | (none) |
| 4 | SZIP | Options mask, pixels per block |
| 5 | NBIT | (class-specific) |
| 6 | SCALEOFFSET | Scale type, scale factor |

### 19.4 Datatype Classes

| Class | Name | Sizes |
|-------|------|-------|
| 0 | Fixed-point (integer) | 1, 2, 4, 8 bytes |
| 1 | Floating-point | 2, 4, 8 bytes |
| 2 | Time | (not supported) |
| 3 | String | Variable |
| 4 | Bitfield | (not supported) |
| 5 | Opaque | (not supported) |
| 6 | Compound | (not supported) |
| 7 | Reference | (not supported) |
| 8 | Enum | (not supported) |
| 9 | Variable-length | (not supported) |
| 10 | Array | (not supported) |

---

## References

- [HDF5 File Format Specification](https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html) — The canonical reference for all byte layouts
- [HDF5 § III.C — Data Object Header Messages](https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html#DataObjectHeaderMessages) — Message type details
- [HDF5 § III.G — Fractal Heap](https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html#FractalHeap) — Fractal heap specification
- [HDF5 § III.A.1 — Disk Format Level 0A: Format Signature and Superblock](https://docs.hdfgroup.org/hdf5/develop/_f_m_t3.html#Superblock) — Superblock versions
- [NISAR L2 GCOV Product Specification (JPL D-102274 Rev E)](https://nisar.jpl.nasa.gov/data/products/) — NISAR product structure
