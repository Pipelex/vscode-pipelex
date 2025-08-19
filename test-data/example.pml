domain = "wip_domain"
definition = "Analyze a photo's most important feature and generate an image depicting its opposite"

[concept.FeatureAnalysis]
definition = "Analysis of a photo's visual content and key features"

[concept.FeatureAnalysis.structure]
dominant_feature = { type = "text", definition = "The most important or dominant feature in the image", required = true }
visual_elements = { type = "text", definition = "Description of key visual elements present", required = true }
composition = "Analysis of the image composition"
color_palette = "Description of the main colors in the image"
mood_atmosphere = "The overall mood or atmosphere of the image"

[concept.OppositeConcept]
definition = "Conceptual description of the opposite of a photo's most important feature"

[concept.OppositeConcept.structure]
opposite_feature = { type = "text", definition = "The conceptual opposite of the dominant feature", required = true }
visual_description = { type = "text", definition = "Visual description of what the opposite would look like", required = true }
reasoning = "Explanation of why this is considered the opposite"
key_differences = "Key differences from the original"

[concept.ImagePrompt]
definition = "Detailed prompt for generating an image"
refines = "images.ImgGenPrompt"

[pipe]

[pipe.gen_photopposite]
type = "PipeSequence"
definition = "Analyze photo and generate its opposite"
inputs = { photo = "native.Image" }
output = "images.Photo"
steps = [
    { pipe = "analyze_features", result = "feature_analysis" },
    { pipe = "conceptualize_opposite", result = "opposite_concept" },
    { pipe = "create_prompt", result = "image_prompt" },
    { pipe = "generate_opposite", result = "opposite_photo" },
]

[pipe.analyze_features]
type = "PipeLLM"
definition = "Analyze photo content and identify key features"
inputs = { photo = "images.Photo" }
output = "FeatureAnalysis"
prompt_template = """Analyze this photo and identify its visual content and key features. Focus on identifying the single most important or dominant feature that defines this image.

@photo

Be concise.
"""

[pipe.conceptualize_opposite]
type = "PipeLLM"
definition = "Determine the most important feature and conceptualize its opposite"
inputs = { feature_analysis = "FeatureAnalysis" }
output = "OppositeConcept"
prompt_template = """Based on this feature analysis, determine the single most important feature and conceptualize its complete opposite. Describe what the opposite would look like in visual terms.

@feature_analysis

Be concise.
"""

[pipe.create_prompt]
type = "PipeLLM"
definition = "Create detailed prompt for opposite photo"
inputs = { opposite_concept = "OppositeConcept" }
output = "ImagePrompt"
prompt_template = """Create a concise image generation prompt that will produce a photo depicting this opposite concept. The prompt should be specific, visual, and suitable for photorealistic image generation.

@opposite_concept

Be concise.
"""

[pipe.generate_opposite]
type = "PipeImgGen"
definition = "Generate the opposite photo"
inputs = { image_prompt = "ImagePrompt" }
output = "images.Photo"
