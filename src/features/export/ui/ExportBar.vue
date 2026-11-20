<script setup lang="ts">
import { computed } from "vue";
import { serialize } from "../lib/serialize";
import { download } from "../model/download";
import { restore } from "../model/storage";
import {
  committedRevision,
  save,
  syncHealthy,
} from "../../collab/model/session";
const label = computed(
  () =>
    `Export SVG ↗  ·  v${committedRevision.value}` +
    (syncHealthy.value ? "" : "（同步中）"),
);
</script>
<template>
  <div class="export">
    <button @click="restore">Restore</button
    ><button @click="save">Save project</button
    ><button
      class="primary"
      data-testid="export"
      :title="
        syncHealthy
          ? '导出已提交的版本'
          : '有改动仍在同步，导出将包含最近一次已提交的版本'
      "
      @click="download(serialize())"
    >
      {{ label }}
    </button>
  </div>
</template>
