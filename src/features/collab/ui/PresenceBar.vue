<script setup lang="ts">
import {
  peerList,
  selfColor,
  selfName,
  syncHealthy,
  syncLabel,
} from "../model/session";
</script>
<template>
  <div class="presence" data-testid="presence">
    <span
      v-for="p in peerList"
      :key="p.id"
      class="avatar"
      :style="{ background: p.color }"
      :title="p.name + '（在线）'"
      >{{ p.name.slice(-4) }}</span
    >
    <span class="avatar me" :style="{ background: selfColor }" :title="selfName"
      >我</span
    >
    <span class="sync" :class="{ ok: syncHealthy }" data-testid="sync-pill">{{
      syncLabel
    }}</span>
  </div>
</template>
