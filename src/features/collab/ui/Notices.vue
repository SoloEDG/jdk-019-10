<script setup lang="ts">
import { notices } from "../model/session";
</script>
<template>
  <div class="notices" data-testid="notices" aria-live="polite">
    <p v-for="n in notices" :key="n.id" :class="n.tone">{{ n.text }}</p>
  </div>
</template>
