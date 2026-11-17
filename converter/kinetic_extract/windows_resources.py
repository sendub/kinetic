"""Windows resources for the game exe (`kinetic apps --windows`).

The Go linker links any `*.syso` COFF object in a package's folder, and
moves an object's `.rsrc` section into the exe's resources. This module
writes such an object: `coff_object(resources)` holds the given resources
in the layout the Microsoft PE/COFF specification gives for the `.rsrc`
section (three directory levels, type, then id, then language; then the
data entries; then the data), with one relocation per data entry so the
linker turns each entry's section offset into an image-relative address.
Each release links the exe once that way (kinetic_extract/app_hosts.py),
with the resources every game shares (docs/plan.md Phase 57 item 10).

`read_resources(exe)` reads an exe's resources back, and
`replace_resources(exe, resources)` gives the exe with its `.rsrc` section
replaced by one holding `resources`, which is how `kinetic apps` writes
each game's icon, version and settings into its copy, on any OS. That
needs `.rsrc` to be the exe's last section, in the file and in memory,
with nothing after it in the file: the Go linker puts it there (after
`.symtab`), and the host build checks it does. The new section may be any
size: it starts where the old one did, its raw size is padded to the
FileAlignment, and the headers that describe it follow (the section's
sizes, SizeOfImage, the resource data directory; SizeOfInitializedData,
which the Go linker makes `.data`'s size alone, stays).
The PE checksum is then computed afresh, though Windows checks it only for
drivers, boot-time DLLs and DLLs loaded into critical system processes,
never for an application like this one (the Go linker writes 0). An exe
with an Authenticode signature is refused: a new `.rsrc` would break it.

`icon_resources`, `version_resource`, `manifest_resource` and
`data_resource` make the resources the exe carries: the icon as RT_ICON
images plus the RT_GROUP_ICON directory Explorer, the taskbar and the game
window read, a VERSIONINFO whose description Task Manager shows, the
application manifest that makes the exe per-monitor DPI aware (v2), so
Windows does not stretch its window on a high-DPI screen, and raw bytes as
RT_RCDATA (the license texts the exe carries, and the game's settings,
which apps/windows/settings.go reads at start).
"""

from __future__ import annotations

import io
import struct
from dataclasses import dataclass

import numpy
from PIL import Image

RT_ICON = 3
RT_RCDATA = 10
RT_GROUP_ICON = 14
RT_VERSION = 16
RT_MANIFEST = 24
# The manifest id Windows reads when it starts an exe
# (CREATEPROCESS_MANIFEST_RESOURCE_ID).
CREATEPROCESS_MANIFEST_ID = 1
LANG_EN_US = 0x0409
CODEPAGE_UNICODE = 1200

# The icon's sizes in pixels; 256 is stored as PNG (the standard for that
# size), the rest as 32-bit bitmaps with alpha.
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)
PNG_FROM = 256

IMAGE_FILE_MACHINE_AMD64 = 0x8664
IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040
IMAGE_SCN_MEM_READ = 0x40000000
IMAGE_REL_AMD64_ADDR32NB = 0x0003  # a 32-bit address relative to the image
IMAGE_SYM_CLASS_STATIC = 3
SUBDIRECTORY = 0x80000000  # high bit of a directory entry's offset
DATA_ALIGN = 8

VS_FIXEDFILEINFO_SIGNATURE = 0xFEEF04BD
VS_FFI_FILEFLAGSMASK = 0x3F
VOS_NT_WINDOWS32 = 0x00040004
VFT_APP = 1


@dataclass(frozen=True)
class Resource:
    """One resource: its type (RT_*), id, language and bytes."""

    type_id: int
    name_id: int
    language: int
    data: bytes


def _align(offset: int, boundary: int) -> int:
    return -(-offset // boundary) * boundary


# --- the .rsrc section and its COFF object ----------------------------------

def resource_section(resources: list[Resource],
                     address: int = 0) -> tuple[bytes, list[int]]:
    """The `.rsrc` section holding `resources`, and the section offsets of
    its data entries' OffsetToData fields. Each field holds its data's
    offset in the section plus `address`: with 0 (a COFF object) the linker
    adds the section's address when it relocates the field; in an exe
    `address` is the section's relative virtual address."""
    tree: dict[int, dict[int, dict[int, bytes]]] = {}
    for res in resources:
        for value in (res.type_id, res.name_id, res.language):
            if not 0 <= value <= 0xFFFF:
                raise ValueError(f"resource id {value} is not a 16-bit number")
        languages = tree.setdefault(res.type_id, {}).setdefault(res.name_id, {})
        if res.language in languages:
            raise ValueError(f"resource {res.type_id}/{res.name_id}/"
                             f"{res.language} is given twice")
        languages[res.language] = res.data

    def table_size(entries: int) -> int:
        return 16 + 8 * entries

    # The directory tables level by level, then the data entries, then the
    # data, each blob on an 8-byte boundary.
    offset = table_size(len(tree))
    type_tables: dict[int, int] = {}
    for type_id in sorted(tree):
        type_tables[type_id] = offset
        offset += table_size(len(tree[type_id]))
    name_tables: dict[tuple[int, int], int] = {}
    for type_id in sorted(tree):
        for name_id in sorted(tree[type_id]):
            name_tables[type_id, name_id] = offset
            offset += table_size(len(tree[type_id][name_id]))
    entries: dict[tuple[int, int, int], int] = {}
    for (type_id, name_id) in name_tables:
        for language in sorted(tree[type_id][name_id]):
            entries[type_id, name_id, language] = offset
            offset += 16
    blobs: dict[tuple[int, int, int], int] = {}
    for key in entries:
        offset = _align(offset, DATA_ALIGN)
        blobs[key] = offset
        offset += len(tree[key[0]][key[1]][key[2]])

    section = bytearray(_align(offset, DATA_ALIGN))

    def write_table(at: int, children: list[tuple[int, int]]) -> None:
        # Characteristics, TimeDateStamp, version 0.0, no named entries,
        # then the id entries in ascending order.
        struct.pack_into("<IIHHHH", section, at, 0, 0, 0, 0, 0, len(children))
        for index, (child_id, child_offset) in enumerate(children):
            struct.pack_into("<II", section, at + 16 + 8 * index,
                             child_id, child_offset)

    write_table(0, [(type_id, SUBDIRECTORY | type_tables[type_id])
                    for type_id in sorted(tree)])
    for type_id, at in type_tables.items():
        write_table(at, [(name_id, SUBDIRECTORY | name_tables[type_id, name_id])
                         for name_id in sorted(tree[type_id])])
    for (type_id, name_id), at in name_tables.items():
        write_table(at, [(language, entries[type_id, name_id, language])
                         for language in sorted(tree[type_id][name_id])])
    for key, at in entries.items():
        data = tree[key[0]][key[1]][key[2]]
        # OffsetToData (relocated, or the data's address), Size, CodePage,
        # Reserved.
        struct.pack_into("<IIII", section, at, address + blobs[key],
                         len(data), 0, 0)
        section[blobs[key]:blobs[key] + len(data)] = data
    return bytes(section), list(entries.values())


def coff_object(resources: list[Resource]) -> bytes:
    """An x86-64 COFF object (a `.syso` for the Go linker) whose one
    section, `.rsrc`, holds `resources`."""
    section, fixups = resource_section(resources)
    if len(fixups) > 0xFFFF:
        raise ValueError("too many resources for one COFF section")
    headers = 20 + 40
    relocations_at = headers + len(section)
    symbols_at = relocations_at + 10 * len(fixups)
    file_header = struct.pack(
        "<HHIIIHH", IMAGE_FILE_MACHINE_AMD64, 1, 0, symbols_at, 1, 0, 0)
    section_header = struct.pack(
        "<8sIIIIIIHHI", b".rsrc", 0, 0, len(section), headers, relocations_at,
        0, len(fixups), 0, IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ)
    # Each relocation adds the section's address to the field at its
    # offset, through symbol 0: the section's own symbol.
    relocations = b"".join(
        struct.pack("<IIH", fixup, 0, IMAGE_REL_AMD64_ADDR32NB)
        for fixup in fixups)
    symbol = struct.pack("<8sIhHBB", b".rsrc", 0, 1, 0, IMAGE_SYM_CLASS_STATIC, 0)
    string_table = struct.pack("<I", 4)  # empty: just its own length
    return file_header + section_header + section + relocations + symbol + string_table


# --- an exe's resources ------------------------------------------------------

PE32_PLUS = 0x20B
# Offsets in a PE32+ optional header.
OPT_SECTION_ALIGNMENT = 32
OPT_FILE_ALIGNMENT = 36
OPT_SIZE_OF_IMAGE = 56
OPT_CHECKSUM = 64
OPT_RVA_COUNT = 108
OPT_DIRECTORIES = 112
DIRECTORY_RESOURCE = 2
DIRECTORY_SECURITY = 4
SECTION_HEADER = 40


@dataclass(frozen=True)
class _Layout:
    """Where an exe's headers and its `.rsrc` section are."""

    optional: int  # the optional header's file offset
    rsrc_header: int  # the .rsrc section header's file offset
    rsrc_address: int  # its relative virtual address
    rsrc_raw_at: int  # its data's file offset
    rsrc_raw_size: int
    rsrc_size: int  # VirtualSize
    resource_size: int  # the resource data directory's size
    section_alignment: int
    file_alignment: int


def _fail(why: str) -> ValueError:
    return ValueError(f"not an exe whose resources can be rewritten: {why}")


def _layout(exe: bytes) -> _Layout:
    """The layout of an x86-64 PE32+ exe whose `.rsrc` is its last section
    with nothing after it; ValueError for any other file."""
    try:
        return _read_layout(exe)
    except struct.error:
        raise _fail("its headers are cut short") from None


def _read_layout(exe: bytes) -> _Layout:
    fail = _fail
    if exe[:2] != b"MZ":
        raise fail("no MZ header")
    if len(exe) < 0x40:
        raise fail("too short for an exe")
    pe_at = struct.unpack_from("<I", exe, 0x3C)[0]
    if exe[pe_at:pe_at + 4] != b"PE\0\0":
        raise fail("no PE signature")
    machine, count, _, _, _, optional_size, _ = struct.unpack_from(
        "<HHIIIHH", exe, pe_at + 4)
    optional = pe_at + 24
    if machine != IMAGE_FILE_MACHINE_AMD64:
        raise fail(f"machine {machine:#x}, not x86-64")
    if struct.unpack_from("<H", exe, optional)[0] != PE32_PLUS:
        raise fail("not PE32+")
    directories = struct.unpack_from("<I", exe, optional + OPT_RVA_COUNT)[0]
    if directories <= DIRECTORY_SECURITY:
        raise fail("too few data directories")
    if struct.unpack_from("<II", exe, optional + OPT_DIRECTORIES
                          + 8 * DIRECTORY_SECURITY) != (0, 0):
        raise fail("it is signed (Authenticode), and a new .rsrc would break "
                   "the signature")
    resource_address, resource_size = struct.unpack_from(
        "<II", exe, optional + OPT_DIRECTORIES + 8 * DIRECTORY_RESOURCE)
    section_alignment, file_alignment = struct.unpack_from(
        "<II", exe, optional + OPT_SECTION_ALIGNMENT)
    table = optional + optional_size
    sections = [struct.unpack_from("<8sIIII", exe, table + SECTION_HEADER * i)
                for i in range(count)]
    if not sections or sections[-1][0] != b".rsrc\0\0\0":
        raise fail(".rsrc is not the last section")
    _, size, address, raw_size, raw_at = sections[-1]
    if any(other[2] >= address or (other[3] and other[4] >= raw_at)
           for other in sections[:-1]):
        raise fail(".rsrc is not the last section in memory and in the file")
    if raw_at + raw_size != len(exe):
        raise fail("data follows .rsrc in the file")
    if resource_address != address:
        raise fail("the resource directory is not the .rsrc section")
    return _Layout(optional, table + SECTION_HEADER * (count - 1), address,
                   raw_at, raw_size, size, resource_size, section_alignment,
                   file_alignment)


def read_resources(exe: bytes) -> list[Resource]:
    """The resources in an exe's `.rsrc` section (the last section; see
    _layout), in type, id and language order. ValueError when the exe is
    not one this module can rewrite, or its resources use names rather
    than ids."""
    layout = _layout(exe)
    section = exe[layout.rsrc_raw_at:
                  layout.rsrc_raw_at + min(layout.rsrc_raw_size,
                                           layout.rsrc_size)]

    def table(at: int, leaf: bool) -> list[tuple[int, int]]:
        if at + 16 > len(section):
            raise ValueError(f"resource table at {at:#x} is outside .rsrc")
        named, ids = struct.unpack_from("<HH", section, at + 12)
        if named:
            raise ValueError("named resources are not supported")
        entries = [struct.unpack_from("<II", section, at + 16 + 8 * i)
                   for i in range(ids)]
        for _, offset in entries:
            if bool(offset & SUBDIRECTORY) == leaf:
                raise ValueError("resource tree is not three levels deep")
        return [(key, offset & ~SUBDIRECTORY) for key, offset in entries]

    found = []
    for type_id, type_at in table(0, False):
        for name_id, name_at in table(type_at, False):
            for language, entry_at in table(name_at, True):
                address, size = struct.unpack_from("<II", section, entry_at)
                at = address - layout.rsrc_address
                if at < 0 or at + size > len(section):
                    raise ValueError(f"resource {type_id}/{name_id}/{language}"
                                     " lies outside .rsrc")
                found.append(Resource(type_id, name_id, language,
                                      section[at:at + size]))
    return found


def pe_checksum(exe: bytes, checksum_at: int) -> int:
    """The PE image checksum (as imagehlp's CheckSumMappedFile computes
    it): the file's 16-bit little-endian words summed with end-around
    carry, the CheckSum field itself counted as 0, plus the file's
    length."""
    data = bytearray(exe)
    data[checksum_at:checksum_at + 4] = bytes(4)
    if len(data) % 2:
        data.append(0)
    total = int(numpy.frombuffer(bytes(data), dtype="<u2").sum(dtype=numpy.uint64))
    while total > 0xFFFF:
        total = (total & 0xFFFF) + (total >> 16)
    return (total + len(exe)) & 0xFFFFFFFF


def replace_resources(exe: bytes, resources: list[Resource]) -> bytes:
    """`exe` with its `.rsrc` section holding `resources` in place of the
    ones it had, its headers and checksum to match (the module notes)."""
    layout = _layout(exe)
    section, _ = resource_section(resources, layout.rsrc_address)
    raw_size = _align(len(section), layout.file_alignment)
    out = bytearray(exe[:layout.rsrc_raw_at])
    out += section + bytes(raw_size - len(section))
    # The section header: VirtualSize, (VirtualAddress kept), SizeOfRawData.
    struct.pack_into("<I", out, layout.rsrc_header + 8, len(section))
    struct.pack_into("<I", out, layout.rsrc_header + 16, raw_size)
    optional = layout.optional
    struct.pack_into("<I", out, optional + OPT_SIZE_OF_IMAGE,
                     _align(layout.rsrc_address + len(section),
                            layout.section_alignment))
    struct.pack_into("<II", out, optional + OPT_DIRECTORIES
                     + 8 * DIRECTORY_RESOURCE, layout.rsrc_address,
                     len(section))
    struct.pack_into("<I", out, optional + OPT_CHECKSUM,
                     pe_checksum(bytes(out), optional + OPT_CHECKSUM))
    return bytes(out)


# --- the icon ----------------------------------------------------------------

def _bitmap(picture: Image.Image) -> bytes:
    """An icon image as a 32-bit bitmap: the header (height doubled, for
    the colour rows plus the mask rows), the BGRA rows bottom-up, then the
    1-bit AND mask (set where the picture is transparent), rows padded to
    32 bits."""
    width, height = picture.size
    rgba = numpy.asarray(picture.convert("RGBA"))[::-1]
    colour = rgba[:, :, [2, 1, 0, 3]].tobytes()
    mask = numpy.packbits(rgba[:, :, 3] == 0, axis=1)
    row = _align(width, 32) // 8
    mask = numpy.pad(mask, ((0, 0), (0, row - mask.shape[1]))).tobytes()
    header = struct.pack("<IiiHHIIiiII", 40, width, 2 * height, 1, 32, 0,
                         len(colour) + len(mask), 0, 0, 0, 0)
    return header + colour + mask


def _png(picture: Image.Image) -> bytes:
    out = io.BytesIO()
    picture.save(out, format="PNG")
    return out.getvalue()


def icon_images(square: Image.Image) -> list[tuple[int, bytes]]:
    """(size, image bytes) for each ICON_SIZES entry, each scaled from the
    square picture itself."""
    images = []
    for size in ICON_SIZES:
        picture = square.convert("RGBA").resize((size, size),
                                                Image.Resampling.LANCZOS)
        images.append((size, _png(picture) if size >= PNG_FROM else _bitmap(picture)))
    return images


def icon_resources(square: Image.Image, group_id: int = 1,
                   language: int = LANG_EN_US) -> list[Resource]:
    """The icon as resources: one RT_ICON per size (ids 1 up) and the
    RT_GROUP_ICON listing them, a .ico file's directory with resource ids
    in place of file offsets."""
    images = icon_images(square)
    group = struct.pack("<HHH", 0, 1, len(images))
    resources = []
    for icon_id, (size, data) in enumerate(images, start=1):
        side = 0 if size >= 256 else size  # 0 means 256
        group += struct.pack("<BBBBHHIH", side, side, 0, 0, 1, 32, len(data),
                             icon_id)
        resources.append(Resource(RT_ICON, icon_id, language, data))
    resources.append(Resource(RT_GROUP_ICON, group_id, language, group))
    return resources


# --- the version resource ----------------------------------------------------

def _utf16(text: str) -> bytes:
    return text.encode("utf-16-le") + b"\0\0"


def _version_block(key: str, value: bytes, value_length: int, text: bool,
                   children: list[bytes]) -> bytes:
    """One VERSIONINFO block: wLength, wValueLength, wType (1 for text),
    the key, the value and the children, each on a 32-bit boundary."""
    block = bytearray(6) + _utf16(key)
    block += bytes(_align(len(block), 4) - len(block)) + value
    for child in children:
        block += bytes(_align(len(block), 4) - len(block)) + child
    if len(block) > 0xFFFF:
        raise ValueError(f"version block {key!r} is too long")
    struct.pack_into("<HHH", block, 0, len(block), value_length, int(text))
    return bytes(block)


def version_resource(strings: dict[str, str], version: tuple[int, int, int, int],
                     language: int = LANG_EN_US) -> Resource:
    """A VERSIONINFO resource: the fixed file info for an application at
    `version`, and `strings` (FileDescription, ProductName...) in one
    string table for `language`, in UTF-16."""
    major, minor, patch, build = version
    high, low = (major << 16) | minor, (patch << 16) | build
    fixed = struct.pack("<13I", VS_FIXEDFILEINFO_SIGNATURE, 0x00010000,
                        high, low, high, low, VS_FFI_FILEFLAGSMASK, 0,
                        VOS_NT_WINDOWS32, VFT_APP, 0, 0, 0)
    table = _version_block(
        f"{language:04X}{CODEPAGE_UNICODE:04X}", b"", 0, True,
        [_version_block(key, _utf16(value), len(_utf16(value)) // 2, True, [])
         for key, value in strings.items()])
    translation = _version_block(
        "Translation", struct.pack("<HH", language, CODEPAGE_UNICODE), 4,
        False, [])
    root = _version_block(
        "VS_VERSION_INFO", fixed, len(fixed), False,
        [_version_block("StringFileInfo", b"", 0, True, [table]),
         _version_block("VarFileInfo", b"", 0, True, [translation])])
    return Resource(RT_VERSION, 1, language, root)


# --- the application manifest ------------------------------------------------

# Microsoft's per-monitor v2 sample ("Setting the default DPI awareness for
# a process", learn.microsoft.com/windows/win32/hidpi, 2025-07-14), with
# dpiAware set to true/pm, the per-monitor setting for Windows before 10
# version 1607, which ignores dpiAwareness. The manifest rather than a
# call at startup, as that page recommends.
APP_MANIFEST = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0" \
xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
  <asmv3:application>
    <asmv3:windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </asmv3:windowsSettings>
  </asmv3:application>
</assembly>
"""


def manifest_resource(language: int = LANG_EN_US) -> Resource:
    """The application manifest as the RT_MANIFEST resource Windows reads
    when it starts the exe, in UTF-8."""
    return Resource(RT_MANIFEST, CREATEPROCESS_MANIFEST_ID, language,
                    APP_MANIFEST.encode("utf-8"))


# --- raw data ------------------------------------------------------------------

def data_resource(name_id: int, data: bytes,
                  language: int = LANG_EN_US) -> Resource:
    """`data` as an RT_RCDATA resource, byte for byte."""
    return Resource(RT_RCDATA, name_id, language, data)
