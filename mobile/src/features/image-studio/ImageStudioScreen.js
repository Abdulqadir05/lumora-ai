import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  IMAGE_GENERATION_TIMEOUT_MS,
  IMAGE_MAX_PROMPT_CHARS,
  IMAGE_PREVIEW_ASPECT_RATIOS,
  imageGenerationErrorMessage,
  requestGeneratedImage,
} from './imageStudioApi';
import { cleanupImageStudioCache, deleteImageFromCache, writeImageToCache } from './imageStudioCache';
import { createImageStudioStyles, createImageStudioTheme } from './imageStudioStyles';

/**
 * @param {{
 *   visible: boolean,
 *   apiBaseUrl: string,
 *   buildHeaders: Function,
 *   onClose: () => void,
 *   tokens: Object,
 *   reducedMotion: boolean,
 *   IconButtonComponent: React.ComponentType<any>,
 *   PressableScaleComponent: React.ComponentType<any>,
 * }} props
 */
export default function ImageStudioScreen({
  visible,
  apiBaseUrl,
  buildHeaders,
  onClose,
  tokens,
  reducedMotion,
  IconButtonComponent: IconButton,
  PressableScaleComponent: PressableScale,
}) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const [permission, requestPermission] = MediaLibrary.usePermissions({ writeOnly: true, granularPermissions: ['photo'] });
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [phase, setPhase] = useState('idle');
  const [notice, setNotice] = useState('');
  const [image, setImage] = useState(null);
  const [saved, setSaved] = useState(false);
  const requestRef = useRef(null);
  const sequenceRef = useRef(0);
  const fileRef = useRef(null);
  const theme = useMemo(() => createImageStudioTheme(tokens), [tokens]);
  const styles = useMemo(() => createImageStudioStyles(theme), [theme]);
  const C = theme.color;
  const SPACE = theme.space;

  useEffect(() => {
    cleanupImageStudioCache();
  }, []);

  const deletePreview = useCallback(() => {
    const uri = fileRef.current;
    fileRef.current = null;
    setImage(null);
    setSaved(false);
    deleteImageFromCache(uri);
  }, []);

  const abortRequest = useCallback(() => {
    const active = requestRef.current;
    if (!active) return;
    requestRef.current = null;
    sequenceRef.current += 1;
    clearTimeout(active.timer);
    active.controller.abort();
  }, []);

  const closeStudio = useCallback(() => {
    abortRequest();
    deletePreview();
    setPhase('idle');
    setNotice('');
    onClose();
  }, [abortRequest, deletePreview, onClose]);

  useEffect(() => {
    if (visible) return;
    abortRequest();
    deletePreview();
    setPhase('idle');
    setNotice('');
  }, [visible, abortRequest, deletePreview]);

  useEffect(() => () => {
    const active = requestRef.current;
    requestRef.current = null;
    if (active) {
      clearTimeout(active.timer);
      active.controller.abort();
    }
    const uri = fileRef.current;
    fileRef.current = null;
    deleteImageFromCache(uri);
  }, []);

  const generateImage = useCallback(async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      setNotice('Describe the image you want to create.');
      setPhase('error');
      return;
    }
    if (cleanPrompt.length > IMAGE_MAX_PROMPT_CHARS) {
      setNotice(`Keep your prompt to ${IMAGE_MAX_PROMPT_CHARS} characters or fewer.`);
      setPhase('error');
      return;
    }
    if (requestRef.current) return;

    deletePreview();
    setNotice('');
    setSaved(false);
    setPhase('generating');
    const controller = new AbortController();
    const requestId = ++sequenceRef.current;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, IMAGE_GENERATION_TIMEOUT_MS);
    requestRef.current = { controller, timer, requestId };
    let pendingFileUri = null;
    try {
      const result = await requestGeneratedImage(apiBaseUrl, cleanPrompt, aspectRatio, controller.signal, buildHeaders);
      if (controller.signal.aborted || requestId !== sequenceRef.current) return;
      const cached = await writeImageToCache(result.bytes, result.contentType);
      pendingFileUri = cached.uri;
      if (controller.signal.aborted || requestId !== sequenceRef.current) {
        deleteImageFromCache(pendingFileUri);
        pendingFileUri = null;
        return;
      }
      fileRef.current = cached.uri;
      setImage({ uri: cached.uri, contentType: result.contentType, aspectRatio });
      pendingFileUri = null;
      setPhase('success');
      AccessibilityInfo.announceForAccessibility?.('Image generated. Preview is ready.');
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return;
      if (requestId !== sequenceRef.current) return;
      const normalized = timedOut ? { kind: 'timeout' } : error;
      const message = imageGenerationErrorMessage(normalized);
      setNotice(message);
      setPhase('error');
      AccessibilityInfo.announceForAccessibility?.(`Image generation failed. ${message}`);
    } finally {
      deleteImageFromCache(pendingFileUri);
      clearTimeout(timer);
      if (requestRef.current?.requestId === requestId) requestRef.current = null;
    }
  }, [apiBaseUrl, aspectRatio, buildHeaders, deletePreview, prompt]);

  const cancelGeneration = useCallback(() => {
    if (!requestRef.current) return;
    abortRequest();
    setPhase('cancelled');
    setNotice('Generation cancelled. Your prompt is still here if you want to try again.');
    AccessibilityInfo.announceForAccessibility?.('Image generation cancelled.');
  }, [abortRequest]);

  const saveImage = useCallback(async () => {
    if (!image || phase !== 'success') return;
    try {
      let granted = permission?.granted;
      if (!granted) granted = (await requestPermission())?.granted;
      if (!granted) {
        setNotice('Photo access was not granted. You can still share the image.');
        return;
      }
      await MediaLibrary.Asset.create(image.uri);
      setSaved(true);
      setNotice('Saved to your photo library.');
    } catch {
      setNotice('Could not save this image. Please try again.');
    }
  }, [image, permission, phase, requestPermission]);

  const shareImage = useCallback(async () => {
    if (!image || phase !== 'success') return;
    try {
      if (!(await Sharing.isAvailableAsync())) {
        setNotice('Sharing is not available on this device.');
        return;
      }
      await Sharing.shareAsync(image.uri, {
        mimeType: image.contentType,
        dialogTitle: 'Share Lumora creation',
        UTI: image.contentType === 'image/png' ? 'public.png' : 'public.jpeg',
      });
    } catch {
      setNotice('Could not open the share sheet. Please try again.');
    }
  }, [image, phase]);

  const busy = phase === 'generating';
  const ratios = ['1:1', '16:9', '9:16', '4:3'];
  const previewAspectRatio = IMAGE_PREVIEW_ASPECT_RATIOS[image?.aspectRatio] || 1;
  const previewWidth = Math.max(1, windowWidth - insets.left - insets.right - SPACE.md * 2);
  const generatedPreviewWidth = Math.min(380 * previewAspectRatio, previewWidth);
  const generatedPreviewHeight = generatedPreviewWidth / previewAspectRatio;

  return (
    <Modal visible={visible} animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={closeStudio} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.imageStudioRoot, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, SPACE.sm) }]}>
        <View style={styles.imageStudioHeader}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.imageStudioEyebrow}>LUMORA · CREATE</Text>
            <Text style={styles.imageStudioTitle} accessibilityRole="header">Image Studio</Text>
          </View>
          <IconButton icon="close" label="Close Image Studio" onPress={closeStudio} />
        </View>
        <ScrollView style={styles.imageStudioScroll} contentContainerStyle={styles.imageStudioContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={styles.imageStudioDescription}>Turn a clear idea into a visual, then save or share it when you choose.</Text>
          <TextInput
            value={prompt}
            onChangeText={(value) => { setPrompt(value); if (phase === 'error' || phase === 'cancelled') { setPhase('idle'); setNotice(''); } }}
            placeholder="Describe the image you want to create…"
            placeholderTextColor={C.textMuted}
            multiline
            maxLength={IMAGE_MAX_PROMPT_CHARS}
            editable={!busy}
            accessibilityLabel="Image prompt"
            accessibilityHint={`Describe an image in up to ${IMAGE_MAX_PROMPT_CHARS} characters.`}
            style={styles.imageStudioPrompt}
            textAlignVertical="top"
          />
          <View style={styles.imageStudioPromptMeta}>
            <Text style={styles.imageStudioFieldLabel}>ASPECT RATIO</Text>
            <Text style={styles.imageStudioCounter}>{prompt.length}/{IMAGE_MAX_PROMPT_CHARS}</Text>
          </View>
          <View style={styles.imageStudioRatioRow} accessibilityRole="radiogroup" accessibilityLabel="Image aspect ratio">
            {ratios.map((ratio) => (
              <PressableScale
                key={ratio}
                onPress={() => setAspectRatio(ratio)}
                disabled={busy}
                accessibilityLabel={ratio}
                accessibilityState={{ selected: aspectRatio === ratio, disabled: busy }}
                style={[styles.imageStudioRatio, aspectRatio === ratio && styles.imageStudioRatioSelected]}
              >
                <Text style={[styles.imageStudioRatioText, aspectRatio === ratio && styles.imageStudioRatioTextSelected]}>{ratio}</Text>
              </PressableScale>
            ))}
          </View>
          <View
            testID="image-preview-frame"
            style={[
              styles.imageStudioPreview,
              image && {
                width: generatedPreviewWidth,
                height: generatedPreviewHeight,
                minHeight: 0,
                maxHeight: undefined,
                aspectRatio: previewAspectRatio,
              },
            ]}
          >
            {image ? (
              <Image source={{ uri: image.uri }} resizeMode="contain" style={styles.imageStudioPreviewImage} accessibilityLabel="Generated image preview" />
            ) : busy ? (
              <View style={styles.imageStudioProgress} accessibilityLiveRegion="polite">
                <ActivityIndicator color={C.primaryBright} size="large" />
                <Text style={styles.imageStudioProgressTitle}>Creating your image</Text>
                <Text style={styles.imageStudioProgressCopy}>This can take a little while.</Text>
              </View>
            ) : (
              <View style={styles.imageStudioEmpty}>
                <View style={styles.imageStudioEmptyMark}><Ionicons name="color-wand-outline" size={28} color={C.primaryBright} /></View>
                <Text style={styles.imageStudioEmptyTitle}>Your canvas is ready</Text>
                <Text style={styles.imageStudioEmptyCopy}>Generated previews stay in temporary app cache.</Text>
              </View>
            )}
          </View>
          {!!notice && <Text style={[styles.imageStudioNotice, phase === 'error' && styles.imageStudioNoticeError]} accessibilityLiveRegion="polite">{notice}</Text>}
          {busy ? (
            <PressableScale onPress={cancelGeneration} accessibilityLabel="Cancel image generation" style={styles.imageStudioCancel}>
              <Ionicons name="close-circle-outline" size={18} color={C.dangerText} />
              <Text style={styles.imageStudioCancelText}>Cancel generation</Text>
            </PressableScale>
          ) : phase === 'error' || phase === 'cancelled' ? (
            <PressableScale onPress={generateImage} accessibilityLabel={phase === 'cancelled' ? 'Try image generation again' : 'Retry image generation'} style={styles.imageStudioPrimary}>
              <Ionicons name="refresh-outline" size={18} color={C.background} />
              <Text style={styles.imageStudioPrimaryText}>Try again</Text>
            </PressableScale>
          ) : image ? (
            <View style={styles.imageStudioActions}>
              <PressableScale onPress={generateImage} accessibilityLabel="Regenerate image" style={styles.imageStudioPrimary}>
                <Ionicons name="refresh-outline" size={18} color={C.background} />
                <Text style={styles.imageStudioPrimaryText}>Regenerate</Text>
              </PressableScale>
              <PressableScale onPress={saveImage} accessibilityLabel={saved ? 'Saved to Photos' : 'Save image to Photos'} style={styles.imageStudioSecondary}>
                <Ionicons name={saved ? 'checkmark' : 'download-outline'} size={18} color={C.primaryBright} />
                <Text style={styles.imageStudioSecondaryText}>{saved ? 'Saved' : 'Save'}</Text>
              </PressableScale>
              <PressableScale onPress={shareImage} accessibilityLabel="Share generated image" style={styles.imageStudioSecondary}>
                <Ionicons name="share-outline" size={18} color={C.secondaryBright} />
                <Text style={styles.imageStudioSecondaryText}>Share</Text>
              </PressableScale>
            </View>
          ) : (
            <PressableScale onPress={generateImage} accessibilityLabel="Generate image" style={styles.imageStudioPrimary}>
              <Ionicons name="sparkles-outline" size={18} color={C.background} />
              <Text style={styles.imageStudioPrimaryText}>Generate image</Text>
            </PressableScale>
          )}
          <Text style={styles.imageStudioPrivacy}>Nothing is added to chat history. Closing Image Studio deletes its temporary preview.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
